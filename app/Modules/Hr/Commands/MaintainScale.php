<?php

declare(strict_types=1);

namespace App\Modules\Hr\Commands;

use App\Modules\Audit\AttemptedOperation;
use App\Modules\Audit\AuditRecorder;
use App\Modules\Hr\Models\Scale;
use App\Support\Authorization\AccessDecision;
use App\Support\Authorization\Actor;
use App\Support\Errors\AuthorizationDenied;
use App\Support\Errors\BusinessRejection;
use App\Support\Idempotency\IdempotentExecution;
use App\Support\Identifiers\RandomIdentifier;
use Illuminate\Support\Facades\DB;

/**
 * Compensation scale catalog: the teacher's compensation rank, independent
 * of skill and academic level. Scales are referenced by contract versions
 * and compensation rules by identity and are never deleted; historical
 * payroll never depends on the catalog remaining active.
 */
final class MaintainScale
{
    public const CAPABILITY = 'hr.scale';

    public function __construct(
        private readonly AccessDecision $access,
        private readonly IdempotentExecution $idempotency,
        private readonly AuditRecorder $audit,
        private readonly AttemptedOperation $attemptedOperation,
    ) {}

    /** @return array{scale_id: string, correlation_id: string} */
    public function register(Actor $actor, string $key, string $name, int $rankOrder, string $idempotencyKey): array
    {
        $payload = hash('sha256', implode('|', ['hr.scale.register', $key, $name, $rankOrder, $actor->actorId]));

        try {
            return $this->idempotency->execute('hr.scale.register', $idempotencyKey, $payload,
                fn (): array => DB::transaction(function () use ($actor, $key, $name, $rankOrder): array {
                    $this->require($actor);
                    if ($key === '' || $name === '') {
                        throw BusinessRejection::forCode('hr.scale_fields', 'a scale requires its catalog key and name');
                    }
                    if ($rankOrder <= 0) {
                        throw BusinessRejection::forCode('hr.scale_rank', 'a scale rank order must be positive');
                    }
                    if (Scale::query()->where('key', $key)->exists()) {
                        throw BusinessRejection::forCode('hr.scale_duplicate', 'this scale key already exists in the catalog');
                    }
                    if (Scale::query()->where('rank_order', $rankOrder)->exists()) {
                        throw BusinessRejection::forCode('hr.scale_rank_duplicate', 'this scale rank order is already taken');
                    }

                    $scale = Scale::query()->create([
                        'id' => RandomIdentifier::new(),
                        'key' => $key,
                        'name' => $name,
                        'rank_order' => $rankOrder,
                        'lifecycle_state' => Scale::STATE_ACTIVE,
                    ]);
                    $event = $this->audit->record($actor->actorId, 'hr.scale.register', 'scale', $scale->id, null, ['key' => $key, 'name' => $name, 'rank_order' => $rankOrder]);

                    return ['scale_id' => $scale->id, 'correlation_id' => $event->correlation_id];
                }),
            );
        } catch (AuthorizationDenied $denial) {
            $this->attemptedOperation->deniedByActor($denial, $actor, 'hr.scale.register', 'scale', $key);
        }
    }

    /** @return array{scale_id: string, lifecycle_state: string, correlation_id: string} */
    public function retire(Actor $actor, Scale $scale, string $idempotencyKey): array
    {
        $payload = hash('sha256', implode('|', ['hr.scale.retire', $scale->id, $actor->actorId]));

        try {
            return $this->idempotency->execute('hr.scale.retire', $idempotencyKey, $payload,
                fn (): array => DB::transaction(function () use ($actor, $scale): array {
                    $this->require($actor);

                    /** @var Scale $locked */
                    $locked = Scale::query()->where('id', $scale->id)->lockForUpdate()->firstOrFail();
                    if ($locked->lifecycle_state !== Scale::STATE_ACTIVE) {
                        throw BusinessRejection::forCode('hr.scale_not_active', 'only an active scale can be retired');
                    }

                    $before = ['lifecycle_state' => $locked->lifecycle_state];
                    $locked->forceFill(['lifecycle_state' => Scale::STATE_RETIRED]);
                    $locked->save();
                    $event = $this->audit->record($actor->actorId, 'hr.scale.retire', 'scale', $locked->id, $before, ['lifecycle_state' => Scale::STATE_RETIRED]);

                    return ['scale_id' => $locked->id, 'lifecycle_state' => Scale::STATE_RETIRED, 'correlation_id' => $event->correlation_id];
                }),
            );
        } catch (AuthorizationDenied $denial) {
            $this->attemptedOperation->deniedByActor($denial, $actor, 'hr.scale.retire', 'scale', $scale->id);
        }
    }

    private function require(Actor $actor): void
    {
        $outcome = $this->access->decide($actor, self::CAPABILITY, null);
        if (! $outcome->allowed) {
            throw AuthorizationDenied::forCode('hr.scale_denied', $outcome->reason);
        }
    }
}
