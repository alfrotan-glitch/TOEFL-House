<?php

declare(strict_types=1);

namespace App\Modules\Reporting\Commands;

use App\Modules\Audit\AttemptedOperation;
use App\Modules\Audit\AuditRecorder;
use App\Modules\Reporting\Models\Dashboard;
use App\Modules\Reporting\Models\DashboardPin;
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
 * Dashboards hold no independent truth: a pin references a registered
 * metric with an explicit period and scope, and only a computed (not
 * stale) projection of the current version may be pinned — incomplete or
 * stale slices are withheld, never silently presented.
 */
final class MaintainDashboard
{
    public const CAPABILITY = 'reporting.dashboard';

    public function __construct(
        private readonly AccessDecision $access,
        private readonly IdempotentExecution $idempotency,
        private readonly AuditRecorder $audit,
        private readonly AttemptedOperation $attemptedOperation,
    ) {}

    /** @return array{dashboard_id: string, correlation_id: string} */
    public function create(Actor $actor, string $name, string $idempotencyKey): array
    {
        $payload = hash('sha256', implode('|', ['reporting.dashboard.create', $name, $actor->actorId]));

        try {
            return $this->idempotency->execute('reporting.dashboard.create', $idempotencyKey, $payload,
                fn (): array => DB::transaction(function () use ($actor, $name): array {
                    $this->require($actor);
                    if (Dashboard::query()->where('name', $name)->exists()) {
                        throw BusinessRejection::forCode('reporting.dashboard_exists', 'this dashboard name already exists');
                    }

                    $dashboard = Dashboard::query()->create([
                        'id' => RandomIdentifier::new(),
                        'name' => $name,
                        'created_by' => $actor->actorId,
                    ]);
                    $event = $this->audit->record($actor->actorId, 'reporting.dashboard.create', 'dashboard', $dashboard->id, null, ['name' => $name]);

                    return ['dashboard_id' => $dashboard->id, 'correlation_id' => $event->correlation_id];
                }),
            );
        } catch (AuthorizationDenied $denial) {
            $this->attemptedOperation->deniedByActor($denial, $actor, 'reporting.dashboard.create', 'dashboard', $name);
        }
    }

    /** @return array{pin_id: string, correlation_id: string} */
    public function pin(Actor $actor, Dashboard $dashboard, string $metricKey, string $periodKey, string $scopeType, ?string $scopeId, string $idempotencyKey): array
    {
        $payload = hash('sha256', implode('|', ['reporting.dashboard.pin', $dashboard->id, $metricKey, $periodKey, $scopeType, (string) $scopeId, $actor->actorId]));

        try {
            return $this->idempotency->execute('reporting.dashboard.pin', $idempotencyKey, $payload,
                fn (): array => DB::transaction(function () use ($actor, $dashboard, $metricKey, $periodKey, $scopeType, $scopeId): array {
                    $this->require($actor);

                    /** @var MetricDefinition $metric */
                    $metric = MetricDefinition::query()->where('key', $metricKey)->firstOrFail();

                    /** @var MetricVersion $currentVersion */
                    $currentVersion = MetricVersion::query()->where('metric_id', $metric->id)->where('version_no', $metric->current_version)->firstOrFail();
                    /** @var MetricProjection|null $projection */
                    $projection = MetricProjection::query()
                        ->where('metric_version_id', $currentVersion->id)
                        ->where('period_key', $periodKey)
                        ->where('scope_type', $scopeType)
                        ->where(fn ($query) => $scopeId === null ? $query->whereNull('scope_id') : $query->where('scope_id', $scopeId))
                        ->first();
                    if ($projection === null) {
                        throw BusinessRejection::forCode('reporting.pin_no_projection', 'pin a computed projection: this slice has never been computed');
                    }
                    if ($projection->completeness !== 'complete') {
                        throw BusinessRejection::forCode('reporting.pin_stale', 'stale slices are withheld from dashboards until rebuilt');
                    }
                    if (DashboardPin::query()->where('dashboard_id', $dashboard->id)->where('metric_id', $metric->id)->where('period_key', $periodKey)->where('scope_type', $scopeType)->where(fn ($query) => $scopeId === null ? $query->whereNull('scope_id') : $query->where('scope_id', $scopeId))->exists()) {
                        throw BusinessRejection::forCode('reporting.pin_exists', 'this slice is already pinned');
                    }

                    $pin = DashboardPin::query()->create([
                        'id' => RandomIdentifier::new(),
                        'dashboard_id' => $dashboard->id,
                        'metric_id' => $metric->id,
                        'period_key' => $periodKey,
                        'scope_type' => $scopeType,
                        'scope_id' => $scopeId,
                        'pinned_by' => $actor->actorId,
                    ]);
                    $event = $this->audit->record($actor->actorId, 'reporting.dashboard.pin', 'dashboard_pin', $pin->id, null, [
                        'dashboard' => $dashboard->id, 'metric' => $metricKey, 'period' => $periodKey,
                    ]);

                    return ['pin_id' => $pin->id, 'correlation_id' => $event->correlation_id];
                }),
            );
        } catch (AuthorizationDenied $denial) {
            $this->attemptedOperation->deniedByActor($denial, $actor, 'reporting.dashboard.pin', 'dashboard_pin', $dashboard->id);
        }
    }

    private function require(Actor $actor): void
    {
        $outcome = $this->access->decide($actor, self::CAPABILITY, null);
        if (! $outcome->allowed) {
            throw AuthorizationDenied::forCode('reporting.dashboard_denied', $outcome->reason);
        }
    }
}
