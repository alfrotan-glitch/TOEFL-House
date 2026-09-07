<?php

declare(strict_types=1);

namespace App\Modules\Reporting\Commands;

use App\Modules\Audit\AttemptedOperation;
use App\Modules\Audit\AuditRecorder;
use App\Modules\Reporting\Domain\MetricCalculator;
use App\Modules\Reporting\Domain\MetricCatalog;
use App\Modules\Reporting\Domain\ReportingScope;
use App\Modules\Reporting\Models\MetricDefinition;
use App\Modules\Reporting\Models\MetricVersion;
use App\Modules\Reporting\Models\ReportRun;
use App\Support\Authorization\AccessDecision;
use App\Support\Authorization\Actor;
use App\Support\Errors\AuthorizationDenied;
use App\Support\Errors\BusinessRejection;
use App\Support\Idempotency\IdempotentExecution;
use App\Support\Identifiers\RandomIdentifier;
use App\Support\Signing\CanonicalJson;
use Illuminate\Support\Facades\DB;

/**
 * Report runs: compute a metric slice fresh through the registered
 * calculator, pin the metric version and the authoritative period key,
 * record filters and scope, and store a reproducibility hash of the
 * exact inputs — the run is immutable, reproducible history.
 */
final class RunReport
{
    public const CAPABILITY = 'reporting.run';

    public function __construct(
        private readonly AccessDecision $access,
        private readonly ReportingScope $scopes,
        private readonly IdempotentExecution $idempotency,
        private readonly AuditRecorder $audit,
        private readonly AttemptedOperation $attemptedOperation,
    ) {}

    /** @param array<string, string> $filters
     * @return array{run_id: string, result: string, completeness: 'complete'|'incomplete', reproducibility_hash: string, correlation_id: string} */
    public function run(Actor $actor, string $metricKey, string $periodKey, string $scopeType, ?string $scopeId, array $filters, string $idempotencyKey): array
    {
        $payload = hash('sha256', implode('|', ['reporting.report.run', $metricKey, $periodKey, $scopeType, (string) $scopeId, CanonicalJson::encode($filters), $actor->actorId]));

        try {
            return $this->idempotency->execute('reporting.report.run', $idempotencyKey, $payload,
                fn (): array => DB::transaction(function () use ($actor, $metricKey, $periodKey, $scopeType, $scopeId, $filters): array {
                    $entry = MetricCatalog::entry($metricKey);
                    if (! in_array($scopeType, $entry['scopes'], true)) {
                        throw BusinessRejection::forCode('reporting.scope_not_allowed', sprintf('metric %s allows scopes %s', $metricKey, implode(', ', $entry['scopes'])));
                    }
                    if (($scopeType === 'global') !== ($scopeId === null)) {
                        throw BusinessRejection::forCode('reporting.scope_shape', 'global scope takes no scope id; every other scope requires one');
                    }
                    if ($scopeType === 'global') {
                        // Global is explicit platform scope. Every target-bound
                        // scope, including Finance-owned funds, is resolved and
                        // authorized by ReportingScope below.
                        $this->require($actor);
                    }
                    $organizationId = $this->scopes->authorize($actor, self::CAPABILITY, $scopeType, $scopeId);

                    /** @var MetricDefinition $metric */
                    $metric = MetricDefinition::query()->where('key', $metricKey)->firstOrFail();
                    MetricCatalog::assertDefinitionLineage($metric, $entry);
                    $periodId = MetricCatalog::resolvePeriod($entry['authority'], $periodKey);

                    /** @var MetricVersion $version */
                    $version = MetricVersion::query()->where('metric_id', $metric->id)->where('version_no', $metric->current_version)->firstOrFail();

                    /** @var MetricCalculator $calculator */
                    $calculator = app($entry['calculator']);
                    $computed = $calculator->compute($periodId, $scopeId);
                    $completeness = (string) ($computed['completeness'] ?? 'complete');
                    if (! in_array($completeness, ['complete', 'incomplete'], true)) {
                        throw new \LogicException('a metric calculator returned an unsupported report-run completeness state');
                    }
                    $meta = $computed['meta'];
                    // Completeness and explanatory metadata are part of the
                    // reproducible result. The same number with a different
                    // evidence basis must never hash as the same report.
                    $hash = hash('sha256', implode('|', [
                        $metricKey,
                        $version->id,
                        $version->version_no,
                        $version->calculation_spec,
                        $periodKey,
                        $scopeType,
                        (string) $scopeId,
                        CanonicalJson::encode($filters),
                        $computed['value'],
                        $completeness,
                        CanonicalJson::encode($meta),
                    ]));

                    $run = ReportRun::query()->create([
                        'id' => RandomIdentifier::new(),
                        'metric_version_id' => $version->id,
                        'period_key' => $periodKey,
                        'scope_type' => $scopeType,
                        'scope_id' => $scopeId,
                        'organization_id' => $organizationId,
                        'filters' => $filters,
                        'result' => $computed['value'],
                        'completeness' => $completeness,
                        'meta' => $meta,
                        'reproducibility_hash' => $hash,
                        'executed_by' => $actor->actorId,
                    ]);
                    $event = $this->audit->record($actor->actorId, 'reporting.report.run', 'report_run', $run->id, null, [
                        'metric' => $metricKey, 'period' => $periodKey, 'scope_type' => $scopeType, 'scope_id' => $scopeId, 'organization_id' => $organizationId,
                        'result' => $computed['value'], 'completeness' => $completeness, 'meta' => $meta,
                    ]);

                    return [
                        'run_id' => $run->id,
                        'result' => $computed['value'],
                        'completeness' => $completeness,
                        'reproducibility_hash' => $hash,
                        'correlation_id' => $event->correlation_id,
                    ];
                }),
            );
        } catch (AuthorizationDenied $denial) {
            $this->attemptedOperation->deniedByActor($denial, $actor, 'reporting.report.run', 'report_run', $metricKey);
        }
    }

    private function require(Actor $actor): void
    {
        $outcome = $this->access->decide($actor, self::CAPABILITY, null);
        if (! $outcome->allowed) {
            throw AuthorizationDenied::forCode('reporting.run_denied', $outcome->reason);
        }
    }
}
