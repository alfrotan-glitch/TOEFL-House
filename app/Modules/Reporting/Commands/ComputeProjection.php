<?php

declare(strict_types=1);

namespace App\Modules\Reporting\Commands;

use App\Modules\Audit\AttemptedOperation;
use App\Modules\Audit\AuditRecorder;
use App\Modules\Reporting\Domain\MetricCalculator;
use App\Modules\Reporting\Domain\MetricCatalog;
use App\Modules\Reporting\Models\MetricDefinition;
use App\Modules\Reporting\Models\MetricProjection;
use App\Modules\Reporting\Models\MetricVersion;
use App\Support\Authorization\AccessDecision;
use App\Support\Authorization\Actor;
use App\Support\Errors\AuthorizationDenied;
use App\Support\Errors\BusinessRejection;
use App\Support\Idempotency\IdempotentExecution;
use App\Support\Identifiers\RandomIdentifier;
use Illuminate\Support\Facades\DB;

/**
 * Projection refresh: computes a slice by dispatching to the registered
 * calculator (the only path to a value) under the metric's authoritative
 * period and declared scope, then upserts the rebuildable slice — the
 * identity (version, period, scope) is fixed; values never enter by hand.
 */
final class ComputeProjection
{
    public const CAPABILITY = 'reporting.compute';

    public function __construct(
        private readonly AccessDecision $access,
        private readonly IdempotentExecution $idempotency,
        private readonly AuditRecorder $audit,
        private readonly AttemptedOperation $attemptedOperation,
    ) {}

    /** @return array{projection_id: string, value: string, correlation_id: string} */
    public function compute(Actor $actor, string $metricKey, string $periodKey, string $scopeType, ?string $scopeId, string $idempotencyKey): array
    {
        $entry = MetricCatalog::entry($metricKey);
        $payload = hash('sha256', implode('|', ['reporting.projection.compute', $metricKey, $periodKey, $scopeType, (string) $scopeId, $actor->actorId]));

        try {
            return $this->idempotency->execute('reporting.projection.compute', $idempotencyKey, $payload,
                fn (): array => DB::transaction(function () use ($actor, $metricKey, $periodKey, $scopeType, $scopeId, $entry): array {
                    $this->require($actor);
                    if (! in_array($scopeType, $entry['scopes'], true)) {
                        throw BusinessRejection::forCode('reporting.scope_not_allowed', sprintf('metric %s allows scopes %s', $metricKey, implode(', ', $entry['scopes'])));
                    }
                    if (($scopeType === 'global') !== ($scopeId === null)) {
                        throw BusinessRejection::forCode('reporting.scope_shape', 'global scope takes no scope id; every other scope requires one');
                    }
                    if ($scopeId === '') {
                        throw BusinessRejection::forCode('reporting.scope_shape', 'the scope id may not be empty');
                    }

                    /** @var MetricDefinition $metric */
                    $metric = MetricDefinition::query()->where('key', $metricKey)->firstOrFail();
                    $periodId = MetricCatalog::resolvePeriod($entry['authority'], $periodKey);

                    /** @var MetricVersion $version */
                    $version = MetricVersion::query()->where('metric_id', $metric->id)->where('version_no', $metric->current_version)->firstOrFail();

                    /** @var MetricCalculator $calculator */
                    $calculator = app($entry['calculator']);
                    $computed = $calculator->compute($periodId, $scopeId);

                    /** @var MetricProjection|null $projection */
                    $projection = MetricProjection::query()
                        ->where('metric_version_id', $version->id)
                        ->where('period_key', $periodKey)
                        ->where('scope_type', $scopeType)
                        ->where(fn ($query) => $scopeId === null ? $query->whereNull('scope_id') : $query->where('scope_id', $scopeId))
                        ->lockForUpdate()
                        ->first();
                    if ($projection === null) {
                        $projection = MetricProjection::query()->create([
                            'id' => RandomIdentifier::new(),
                            'metric_version_id' => $version->id,
                            'period_key' => $periodKey,
                            'scope_type' => $scopeType,
                            'scope_id' => $scopeId,
                            'value' => $computed['value'],
                            'completeness' => 'complete',
                            'meta' => $computed['meta'],
                            'computed_at' => now(),
                            'computed_by' => $actor->actorId,
                        ]);
                    } else {
                        $projection->forceFill([
                            'value' => $computed['value'],
                            'completeness' => 'complete',
                            'meta' => $computed['meta'],
                            'computed_at' => now(),
                            'computed_by' => $actor->actorId,
                        ]);
                        $projection->save();
                    }
                    $event = $this->audit->record($actor->actorId, 'reporting.projection.compute', 'metric_projection', $projection->id, null, [
                        'metric' => $metricKey, 'period' => $periodKey, 'value' => $computed['value'],
                    ]);

                    return ['projection_id' => $projection->id, 'value' => $computed['value'], 'correlation_id' => $event->correlation_id];
                }),
            );
        } catch (AuthorizationDenied $denial) {
            $this->attemptedOperation->deniedByActor($denial, $actor, 'reporting.projection.compute', 'metric_projection', $metricKey);
        }
    }

    private function require(Actor $actor): void
    {
        $outcome = $this->access->decide($actor, self::CAPABILITY, null);
        if (! $outcome->allowed) {
            throw AuthorizationDenied::forCode('reporting.compute_denied', $outcome->reason);
        }
    }
}
