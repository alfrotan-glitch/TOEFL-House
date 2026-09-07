<?php

declare(strict_types=1);

namespace App\Modules\Reporting\Commands;

use App\Modules\Audit\AttemptedOperation;
use App\Modules\Audit\AuditRecorder;
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
 * Metric catalog: only canonical catalog metrics are definable, and the
 * calculation specification is versioned — a revision appends a new
 * version (old versions are immutable history) and marks projections of
 * superseded versions stale so they are labeled, never silently trusted.
 */
final class DefineMetric
{
    public const CAPABILITY = 'reporting.catalog';

    public function __construct(
        private readonly AccessDecision $access,
        private readonly IdempotentExecution $idempotency,
        private readonly AuditRecorder $audit,
        private readonly AttemptedOperation $attemptedOperation,
    ) {}

    /** @return array{metric_id: string, version_no: int, correlation_id: string} */
    public function define(Actor $actor, string $metricKey, string $name, string $spec, string $effectiveFrom, string $idempotencyKey): array
    {
        $payload = hash('sha256', implode('|', ['reporting.metric.define', $metricKey, $name, $spec, $effectiveFrom, $actor->actorId]));

        try {
            return $this->idempotency->execute('reporting.metric.define', $idempotencyKey, $payload,
                fn (): array => DB::transaction(function () use ($actor, $metricKey, $name, $spec, $effectiveFrom): array {
                    $this->require($actor);

                    $entry = MetricCatalog::entry($metricKey);
                    if ($spec === '') {
                        throw BusinessRejection::forCode('reporting.metric_spec', 'a metric requires its calculation specification');
                    }
                    if (MetricDefinition::query()->where('key', $metricKey)->exists()) {
                        throw BusinessRejection::forCode('reporting.metric_exists', 'this metric is already defined');
                    }

                    $metric = MetricDefinition::query()->create([
                        'id' => RandomIdentifier::new(),
                        'key' => $metricKey,
                        'name' => $name,
                        // The owner claim and canonical owner agree for a
                        // newly defined catalog metric. Historical claims are
                        // never rewritten; see the lineage migration.
                        'source_owner' => $entry['owner'],
                        'canonical_source_owner' => $entry['owner'],
                        'period_authority' => $entry['authority'],
                        'current_version' => 1,
                        'defined_by' => $actor->actorId,
                        'lineage_status' => 'aligned',
                        'lineage_basis' => 'catalog_2026_09_07',
                        'lineage_recorded_at' => now(),
                    ]);
                    MetricVersion::query()->create([
                        'id' => RandomIdentifier::new(),
                        'metric_id' => $metric->id,
                        'version_no' => 1,
                        'calculation_spec' => $spec,
                        'effective_from' => $effectiveFrom,
                        'created_by' => $actor->actorId,
                    ]);
                    $event = $this->audit->record($actor->actorId, 'reporting.metric.define', 'metric_definition', $metric->id, null, [
                        'key' => $metricKey,
                        'source_owner_claim' => $metric->source_owner,
                        'canonical_source_owner' => $metric->canonical_source_owner,
                        'period_authority' => $metric->period_authority,
                        'lineage_status' => $metric->lineage_status,
                        'lineage_basis' => $metric->lineage_basis,
                    ]);

                    return ['metric_id' => $metric->id, 'version_no' => 1, 'correlation_id' => $event->correlation_id];
                }),
            );
        } catch (AuthorizationDenied $denial) {
            $this->attemptedOperation->deniedByActor($denial, $actor, 'reporting.metric.define', 'metric_definition', $metricKey);
        }
    }

    /** @return array{metric_id: string, version_no: int, correlation_id: string} */
    public function revise(Actor $actor, MetricDefinition $metric, string $spec, string $effectiveFrom, string $idempotencyKey): array
    {
        $payload = hash('sha256', implode('|', ['reporting.metric.revise', $metric->id, $spec, $effectiveFrom, $actor->actorId]));

        try {
            return $this->idempotency->execute('reporting.metric.revise', $idempotencyKey, $payload,
                fn (): array => DB::transaction(function () use ($actor, $metric, $spec, $effectiveFrom): array {
                    $this->require($actor);
                    if ($spec === '') {
                        throw BusinessRejection::forCode('reporting.metric_spec', 'a metric requires its calculation specification');
                    }

                    /** @var MetricDefinition $locked */
                    $locked = MetricDefinition::query()->whereKey($metric->id)->lockForUpdate()->firstOrFail();
                    MetricCatalog::assertDefinitionLineage($locked, MetricCatalog::entry((string) $locked->key));
                    $nextVersion = $locked->current_version + 1;
                    MetricVersion::query()->create([
                        'id' => RandomIdentifier::new(),
                        'metric_id' => $locked->id,
                        'version_no' => $nextVersion,
                        'calculation_spec' => $spec,
                        'effective_from' => $effectiveFrom,
                        'created_by' => $actor->actorId,
                    ]);

                    $supersededIds = MetricVersion::query()->where('metric_id', $locked->id)->where('version_no', '<', $nextVersion)->pluck('id');
                    MetricProjection::query()->whereIn('metric_version_id', $supersededIds)->update(['completeness' => 'stale']);
                    $locked->forceFill(['current_version' => $nextVersion]);
                    $locked->save();

                    $event = $this->audit->record($actor->actorId, 'reporting.metric.revise', 'metric_definition', $locked->id, null, ['version_no' => $nextVersion]);

                    return ['metric_id' => $locked->id, 'version_no' => $nextVersion, 'correlation_id' => $event->correlation_id];
                }),
            );
        } catch (AuthorizationDenied $denial) {
            $this->attemptedOperation->deniedByActor($denial, $actor, 'reporting.metric.revise', 'metric_definition', $metric->id);
        }
    }

    private function require(Actor $actor): void
    {
        $outcome = $this->access->decide($actor, self::CAPABILITY, null);
        if (! $outcome->allowed) {
            throw AuthorizationDenied::forCode('reporting.catalog_denied', $outcome->reason);
        }
    }
}
