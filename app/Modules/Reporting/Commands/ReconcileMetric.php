<?php

declare(strict_types=1);

namespace App\Modules\Reporting\Commands;

use App\Modules\Audit\AttemptedOperation;
use App\Modules\Audit\AuditRecorder;
use App\Modules\Reporting\Domain\MetricCalculator;
use App\Modules\Reporting\Domain\MetricCatalog;
use App\Modules\Reporting\Domain\ReportingScope;
use App\Modules\Reporting\Models\MetricDefinition;
use App\Modules\Reporting\Models\MetricProjection;
use App\Modules\Reporting\Models\MetricReconciliation;
use App\Modules\Reporting\Models\MetricVersion;
use App\Support\Authorization\AccessDecision;
use App\Support\Authorization\Actor;
use App\Support\Errors\AuthorizationDenied;
use App\Support\Errors\BusinessRejection;
use App\Support\Idempotency\IdempotentExecution;
use App\Support\Identifiers\RandomIdentifier;
use Illuminate\Support\Facades\DB;

/**
 * Source reconciliation: recompute the metric straight from the
 * authoritative source and compare with the latest reported projection —
 * divergence is recorded as an exception for the source owner; never an
 * alternate truth.
 */
final class ReconcileMetric
{
    public const CAPABILITY = 'reporting.reconcile';

    public function __construct(
        private readonly AccessDecision $access,
        private readonly ReportingScope $scopes,
        private readonly IdempotentExecution $idempotency,
        private readonly AuditRecorder $audit,
        private readonly AttemptedOperation $attemptedOperation,
    ) {}

    /** @return array{reconciliation_id: string, status: string, variance: string, correlation_id: string} */
    public function reconcile(Actor $actor, string $metricKey, string $periodKey, string $scopeType, ?string $scopeId, string $idempotencyKey): array
    {
        $payload = hash('sha256', implode('|', ['reporting.reconcile', $metricKey, $periodKey, $scopeType, (string) $scopeId, $actor->actorId]));

        try {
            return $this->idempotency->execute('reporting.reconcile', $idempotencyKey, $payload,
                fn (): array => DB::transaction(function () use ($actor, $metricKey, $periodKey, $scopeType, $scopeId): array {
                    $entry = MetricCatalog::entry($metricKey);
                    if (! in_array($scopeType, $entry['scopes'], true)) {
                        throw BusinessRejection::forCode('reporting.scope_not_allowed', sprintf('metric %s allows scopes %s', $metricKey, implode(', ', $entry['scopes'])));
                    }
                    if (($scopeType === 'global') !== ($scopeId === null)) {
                        throw BusinessRejection::forCode('reporting.scope_shape', 'global scope takes no scope id; every other scope requires one');
                    }
                    if ($scopeId === '') {
                        throw BusinessRejection::forCode('reporting.scope_shape', 'the scope id may not be empty');
                    }
                    if (in_array($scopeType, ['global', 'fund'], true)) {
                        // Organization-wide scopes require organization-rooted
                        // authority; branch/campus grants are not wildcards.
                        $this->require($actor);
                    }
                    $organizationId = $this->scopes->authorize($actor, self::CAPABILITY, $scopeType, $scopeId);

                    /** @var MetricDefinition $metric */
                    $metric = MetricDefinition::query()->where('key', $metricKey)->firstOrFail();
                    $periodId = MetricCatalog::resolvePeriod($entry['authority'], $periodKey);
                    /** @var MetricVersion $version */
                    $version = MetricVersion::query()->where('metric_id', $metric->id)->where('version_no', $metric->current_version)->firstOrFail();

                    /** @var MetricCalculator $calculator */
                    $calculator = app($entry['calculator']);
                    $authoritative = $calculator->compute($periodId, $scopeId);

                    /** @var MetricProjection|null $reported */
                    $reported = MetricProjection::query()
                        ->where('metric_version_id', $version->id)
                        ->where('period_key', $periodKey)
                        ->where('scope_type', $scopeType)
                        ->where(fn ($query) => $scopeId === null ? $query->whereNull('scope_id') : $query->where('scope_id', $scopeId))
                        ->orderByDesc('computed_at')
                        ->lockForUpdate()
                        ->first();
                    if ($reported === null) {
                        throw BusinessRejection::forCode('reporting.nothing_reported', 'no projection exists to reconcile');
                    }
                    $reportedOrganizationId = trim((string) $reported->organization_id);
                    if (($organizationId === null && $reportedOrganizationId !== '') || ($organizationId !== null && $reportedOrganizationId !== $organizationId)) {
                        throw BusinessRejection::forCode('reporting.projection_scope_conflict', 'the reported projection has stale organization provenance for its current scope');
                    }

                    $variance = bcsub((string) $reported->value, $authoritative['value'], 4);
                    $status = bccomp($variance, '0.0000', 4) === 0 ? 'matched' : 'diverged';
                    $reconciliation = MetricReconciliation::query()->create([
                        'id' => RandomIdentifier::new(),
                        'metric_id' => $metric->id,
                        'period_key' => $periodKey,
                        'scope_type' => $scopeType,
                        'scope_id' => $scopeId,
                        'reported_value' => (string) $reported->value,
                        'authoritative_value' => $authoritative['value'],
                        'variance' => $variance,
                        'status' => $status,
                        'reconciled_by' => $actor->actorId,
                    ]);
                    $event = $this->audit->record($actor->actorId, 'reporting.reconcile', 'metric_reconciliation', $reconciliation->id, null, [
                        'metric' => $metricKey, 'period' => $periodKey, 'status' => $status, 'variance' => $variance,
                    ]);

                    return ['reconciliation_id' => $reconciliation->id, 'status' => $status, 'variance' => $variance, 'correlation_id' => $event->correlation_id];
                }),
            );
        } catch (AuthorizationDenied $denial) {
            $this->attemptedOperation->deniedByActor($denial, $actor, 'reporting.reconcile', 'metric_reconciliation', $metricKey);
        }
    }

    private function require(Actor $actor): void
    {
        $outcome = $this->access->decide($actor, self::CAPABILITY, null);
        if (! $outcome->allowed) {
            throw AuthorizationDenied::forCode('reporting.reconcile_denied', $outcome->reason);
        }
    }
}
