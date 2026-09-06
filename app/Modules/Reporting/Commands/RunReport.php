<?php

declare(strict_types=1);

namespace App\Modules\Reporting\Commands;

use App\Modules\Audit\AttemptedOperation;
use App\Modules\Audit\AuditRecorder;
use App\Modules\Reporting\Domain\MetricCalculator;
use App\Modules\Reporting\Domain\MetricCatalog;
use App\Modules\Reporting\Models\MetricDefinition;
use App\Modules\Reporting\Models\MetricVersion;
use App\Modules\Reporting\Models\ReportRun;
use App\Support\Authorization\AccessDecision;
use App\Support\Authorization\Actor;
use App\Support\Errors\AuthorizationDenied;
use App\Support\Errors\BusinessRejection;
use App\Support\Idempotency\IdempotentExecution;
use App\Support\Identifiers\RandomIdentifier;
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
        private readonly IdempotentExecution $idempotency,
        private readonly AuditRecorder $audit,
        private readonly AttemptedOperation $attemptedOperation,
    ) {}

    /** @param array<string, string> $filters
     * @return array{run_id: string, result: string, reproducibility_hash: string, correlation_id: string} */
    public function run(Actor $actor, string $metricKey, string $periodKey, string $scopeType, ?string $scopeId, array $filters, string $idempotencyKey): array
    {
        $payload = hash('sha256', implode('|', ['reporting.report.run', $metricKey, $periodKey, $scopeType, (string) $scopeId, json_encode($filters), $actor->actorId]));

        try {
            return $this->idempotency->execute('reporting.report.run', $idempotencyKey, $payload,
                fn (): array => DB::transaction(function () use ($actor, $metricKey, $periodKey, $scopeType, $scopeId, $filters): array {
                    $this->require($actor);

                    $entry = MetricCatalog::entry($metricKey);
                    if (! in_array($scopeType, $entry['scopes'], true)) {
                        throw BusinessRejection::forCode('reporting.scope_not_allowed', sprintf('metric %s allows scopes %s', $metricKey, implode(', ', $entry['scopes'])));
                    }
                    if (($scopeType === 'global') !== ($scopeId === null)) {
                        throw BusinessRejection::forCode('reporting.scope_shape', 'global scope takes no scope id; every other scope requires one');
                    }

                    /** @var MetricDefinition $metric */
                    $metric = MetricDefinition::query()->where('key', $metricKey)->firstOrFail();
                    $periodId = MetricCatalog::resolvePeriod($entry['authority'], $periodKey);

                    /** @var MetricVersion $version */
                    $version = MetricVersion::query()->where('metric_id', $metric->id)->where('version_no', $metric->current_version)->firstOrFail();

                    /** @var MetricCalculator $calculator */
                    $calculator = app($entry['calculator']);
                    $computed = $calculator->compute($periodId, $scopeId);
                    $hash = hash('sha256', implode('|', [$metricKey, $version->id, $version->version_no, $version->calculation_spec, $periodKey, $scopeType, (string) $scopeId, json_encode($filters), $computed['value']]));

                    $run = ReportRun::query()->create([
                        'id' => RandomIdentifier::new(),
                        'metric_version_id' => $version->id,
                        'period_key' => $periodKey,
                        'scope_type' => $scopeType,
                        'scope_id' => $scopeId,
                        'filters' => $filters,
                        'result' => $computed['value'],
                        'reproducibility_hash' => $hash,
                        'executed_by' => $actor->actorId,
                    ]);
                    $event = $this->audit->record($actor->actorId, 'reporting.report.run', 'report_run', $run->id, null, [
                        'metric' => $metricKey, 'period' => $periodKey, 'result' => $computed['value'],
                    ]);

                    return ['run_id' => $run->id, 'result' => $computed['value'], 'reproducibility_hash' => $hash, 'correlation_id' => $event->correlation_id];
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
