<?php

declare(strict_types=1);

namespace App\Modules\Governance\Commands;

use App\Modules\Audit\AttemptedOperation;
use App\Modules\Audit\AuditRecorder;
use App\Modules\Governance\Domain\GovernedConfigType;
use App\Modules\Governance\Models\GovernedConfig;
use App\Modules\Governance\Models\GovernedConfigDefinition;
use App\Support\Authorization\AccessDecision;
use App\Support\Authorization\Actor;
use App\Support\Errors\AuthorizationDenied;
use App\Support\Errors\BusinessRejection;
use App\Support\Idempotency\IdempotentExecution;
use App\Support\Identifiers\RandomIdentifier;
use Carbon\CarbonImmutable;
use Illuminate\Support\Facades\DB;

/**
 * Governed configuration control (WP-2 S1). Every write is an authorized,
 * audited, idempotent event that APPENDS a new effective version — history is
 * never rewritten in place. Declaration (ratifying a key + its fixed type) is
 * the governance boundary; activation records a typed, effective value for a
 * ratified key, retiring the previous OPEN version into an immutable window as
 * needed. Required governed configuration fails closed on read; it is never
 * invented or defaulted here.
 */
final class MaintainGovernedConfig
{
    public const CAPABILITY = 'governance.config';

    public function __construct(
        private readonly AccessDecision $access,
        private readonly IdempotentExecution $idempotency,
        private readonly AuditRecorder $audit,
        private readonly AttemptedOperation $attemptedOperation,
    ) {}

    /** @return array{config_key: string, correlation_id: string} */
    public function ratifyDefinition(Actor $actor, string $configKey, string $configType, string $title, string $idempotencyKey): array
    {
        $payload = hash('sha256', implode('|', [
            'governance.config.ratify', $configKey, $configType, $title, $actor->actorId,
        ]));

        try {
            return $this->idempotency->execute('governance.config.ratify', $idempotencyKey, $payload,
                fn (): array => DB::transaction(function () use ($actor, $configKey, $configType, $title): array {
                    $this->requireCapability($actor);
                    if (trim($configKey) === '') {
                        throw BusinessRejection::forCode('governance.key_required', 'a governed configuration requires a key');
                    }
                    if (trim($title) === '') {
                        throw BusinessRejection::forCode('governance.definition_title_required', 'a governed configuration definition requires a title');
                    }
                    if (! GovernedConfigType::isKnown($configType)) {
                        throw BusinessRejection::forCode('governance.config_type_unknown', sprintf('unsupported governed config type "%s"', $configType));
                    }
                    if (GovernedConfigDefinition::query()->where('config_key', $configKey)->exists()) {
                        throw BusinessRejection::forCode('governance.definition_exists', 'this governed configuration key is already ratified');
                    }

                    $definition = GovernedConfigDefinition::query()->create([
                        'id' => RandomIdentifier::new(),
                        'config_key' => $configKey,
                        'config_type' => $configType,
                        'title' => $title,
                        'ratified_by' => $actor->actorId,
                    ]);
                    $event = $this->audit->record($actor->actorId, 'governance.config.ratify', 'governed_config_definition', $definition->id, null, [
                        'config_key' => $configKey, 'config_type' => $configType, 'title' => $title,
                    ]);

                    return ['config_key' => $configKey, 'correlation_id' => $event->correlation_id];
                }),
            );
        } catch (AuthorizationDenied $denial) {
            $this->attemptedOperation->deniedByActor($denial, $actor, 'governance.config.ratify', 'governed_config_definition', $configKey);
        }
    }

    /**
     * Records a typed effective value for a ratified key. If the key already
     * has an OPEN (active) version, that version is retired into an immutable
     * window ending at the new effective_from and the new value supersedes it —
     * append-only, audited, no silent rewrite.
     *
     * @return array{version_id: string, version_no: int, effective_from: string, supersedes_id: string|null, correlation_id: string}
     */
    public function activateConfig(Actor $actor, string $configKey, int|string $value, CarbonImmutable $effectiveFrom, string $idempotencyKey): array
    {
        $payload = hash('sha256', implode('|', [
            'governance.config.activate', $configKey, is_int($value) ? 'i:'.$value : 's:'.$value, $effectiveFrom->toDateString(), $actor->actorId,
        ]));

        try {
            return $this->idempotency->execute('governance.config.activate', $idempotencyKey, $payload,
                fn (): array => DB::transaction(function () use ($actor, $configKey, $value, $effectiveFrom): array {
                    $this->requireCapability($actor);

                    $definition = GovernedConfigDefinition::query()->where('config_key', $configKey)->first();
                    if ($definition === null) {
                        throw BusinessRejection::forCode('governance.config_undefined', sprintf('governed configuration "%s" must be ratified before a value can be activated', $configKey));
                    }
                    GovernedConfigType::assertValue($definition->config_type, $value);

                    $from = $effectiveFrom->startOfDay()->toDateString();
                    $before = null;
                    $supersedesId = null;

                    /** @var GovernedConfig|null $open */
                    $open = GovernedConfig::query()
                        ->where('config_key', $configKey)
                        ->where('lifecycle_state', GovernedConfig::STATE_ACTIVE)
                        ->lockForUpdate()
                        ->first();

                    if ($open !== null) {
                        $openFrom = $open->effective_from->toDateString();
                        if (strcmp($from, $openFrom) <= 0) {
                            throw BusinessRejection::forCode('governance.effective_overlap', sprintf('a new version must take effect strictly after the current version (%s)', $openFrom));
                        }

                        // Retire the OPEN version into a finite, immutable window.
                        DB::table('governed_configs')
                            ->where('id', $open->id)
                            ->update([
                                'lifecycle_state' => GovernedConfig::STATE_ENDED,
                                'effective_to' => $from,
                                'updated_at' => now(),
                            ]);
                        $before = [
                            'version_no' => $open->version_no,
                            'value' => $open->value,
                            'effective_from' => $openFrom,
                            'effective_to' => null,
                            'lifecycle_state' => GovernedConfig::STATE_ACTIVE,
                        ];
                        $supersedesId = $open->id;
                        $versionNo = $open->version_no + 1;
                    } else {
                        /** @var int $maxVersion */
                        $maxVersion = (int) GovernedConfig::query()->where('config_key', $configKey)->max('version_no');
                        $versionNo = $maxVersion + 1;
                    }

                    $version = GovernedConfig::query()->create([
                        'id' => RandomIdentifier::new(),
                        'config_key' => $configKey,
                        'config_type' => $definition->config_type,
                        'version_no' => $versionNo,
                        'value' => ['v' => $value],
                        'effective_from' => $from,
                        'effective_to' => null,
                        'supersedes_id' => $supersedesId,
                        'lifecycle_state' => GovernedConfig::STATE_ACTIVE,
                        'review_cycle' => null,
                        'approved_by' => $actor->actorId,
                    ]);
                    $event = $this->audit->record($actor->actorId, 'governance.config.activate', 'governed_config', $version->id, $before, [
                        'config_key' => $configKey,
                        'config_type' => $definition->config_type,
                        'version_no' => $versionNo,
                        'value' => $version->value,
                        'effective_from' => $from,
                        'effective_to' => null,
                        'supersedes_id' => $supersedesId,
                        'lifecycle_state' => GovernedConfig::STATE_ACTIVE,
                        'approved_by' => $actor->actorId,
                    ]);

                    return [
                        'version_id' => $version->id,
                        'version_no' => $versionNo,
                        'effective_from' => $from,
                        'supersedes_id' => $supersedesId,
                        'correlation_id' => $event->correlation_id,
                    ];
                }),
            );
        } catch (AuthorizationDenied $denial) {
            $this->attemptedOperation->deniedByActor($denial, $actor, 'governance.config.activate', 'governed_config', $configKey);
        }
    }

    private function requireCapability(Actor $actor): void
    {
        $outcome = $this->access->decide($actor, self::CAPABILITY, null);
        if (! $outcome->allowed) {
            throw AuthorizationDenied::forCode('governance.config_denied', $outcome->reason);
        }
    }
}
