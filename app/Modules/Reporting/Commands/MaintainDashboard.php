<?php

declare(strict_types=1);

namespace App\Modules\Reporting\Commands;

use App\Modules\Audit\AttemptedOperation;
use App\Modules\Audit\AuditRecorder;
use App\Modules\Organization\Models\Organization;
use App\Modules\Reporting\Domain\MetricCatalog;
use App\Modules\Reporting\Domain\ReportingScope;
use App\Modules\Reporting\Models\Dashboard;
use App\Modules\Reporting\Models\DashboardPin;
use App\Modules\Reporting\Models\MetricDefinition;
use App\Modules\Reporting\Models\MetricProjection;
use App\Modules\Reporting\Models\MetricVersion;
use App\Support\Authorization\AccessDecision;
use App\Support\Authorization\Actor;
use App\Support\Authorization\StructureScope;
use App\Support\Errors\AuthorizationDenied;
use App\Support\Errors\BusinessRejection;
use App\Support\Idempotency\IdempotentExecution;
use App\Support\Identifiers\RandomIdentifier;
use Illuminate\Support\Facades\DB;

/**
 * Dashboards hold no independent truth: a pin references a registered
 * metric with an explicit period and scope, and only a complete projection
 * of the current version may be pinned — stale or historically incomplete
 * slices are withheld, never silently presented.
 */
final class MaintainDashboard
{
    public const CAPABILITY = 'reporting.dashboard';

    public function __construct(
        private readonly AccessDecision $access,
        private readonly ReportingScope $scopes,
        private readonly IdempotentExecution $idempotency,
        private readonly AuditRecorder $audit,
        private readonly AttemptedOperation $attemptedOperation,
    ) {}

    /** @return array{dashboard_id: string, correlation_id: string} */
    public function create(Actor $actor, string $name, string $idempotencyKey, ?string $organizationId = null): array
    {
        $payload = hash('sha256', implode('|', ['reporting.dashboard.create', $name, $organizationId ?? '', $actor->actorId]));

        try {
            return $this->idempotency->execute('reporting.dashboard.create', $idempotencyKey, $payload,
                fn (): array => DB::transaction(function () use ($actor, $name, $organizationId): array {
                    $resolvedOrganizationId = $this->resolveOrganization($actor, $organizationId);
                    if (trim($name) === '') {
                        throw BusinessRejection::forCode('reporting.dashboard_name_required', 'a dashboard requires a name');
                    }
                    if (Dashboard::query()->where('organization_id', $resolvedOrganizationId)->where('name', $name)->exists()) {
                        throw BusinessRejection::forCode('reporting.dashboard_exists', 'this dashboard name already exists');
                    }

                    $dashboard = Dashboard::query()->create([
                        'id' => RandomIdentifier::new(),
                        'name' => $name,
                        'organization_id' => $resolvedOrganizationId,
                        'created_by' => $actor->actorId,
                    ]);
                    $event = $this->audit->record($actor->actorId, 'reporting.dashboard.create', 'dashboard', $dashboard->id, null, ['name' => $name, 'organization_id' => $resolvedOrganizationId]);

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
                    /** @var Dashboard $lockedDashboard */
                    $lockedDashboard = Dashboard::query()->whereKey($dashboard->id)->lockForUpdate()->firstOrFail();
                    $this->require($actor, (string) $lockedDashboard->organization_id);
                    $entry = MetricCatalog::entry($metricKey);
                    if (! in_array($scopeType, $entry['scopes'], true)) {
                        throw BusinessRejection::forCode('reporting.pin_scope_not_allowed', 'the dashboard pin scope is not allowed for this metric');
                    }
                    if (($scopeType === 'global') !== ($scopeId === null) || ($scopeId !== null && trim($scopeId) === '')) {
                        throw BusinessRejection::forCode('reporting.pin_scope_shape', 'global pins take no scope id; every other pin requires one');
                    }
                    // Every dashboard is organization-owned. A platform-global
                    // projection is deliberately not an organization result and
                    // therefore cannot be pinned into this tenant view.
                    if ($scopeType === 'global') {
                        throw BusinessRejection::forCode('reporting.pin_global_scope_forbidden', 'organization-owned dashboards cannot pin global projections');
                    }
                    // Resolve every target through the same scope authority
                    // used by report execution. A dashboard's organization
                    // authorization alone must not turn an inactive, malformed,
                    // or foreign target into a valid tenant pin.
                    $targetOrganizationId = $this->scopes->authorize($actor, self::CAPABILITY, $scopeType, $scopeId);
                    if ($targetOrganizationId === null
                        || $targetOrganizationId !== trim((string) $lockedDashboard->organization_id)) {
                        throw BusinessRejection::forCode('reporting.pin_scope_conflict', 'the pin target and dashboard organization provenance do not agree');
                    }

                    /** @var MetricDefinition $metric */
                    $metric = MetricDefinition::query()->where('key', $metricKey)->firstOrFail();
                    MetricCatalog::assertDefinitionLineage($metric, $entry);

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
                        throw BusinessRejection::forCode('reporting.pin_stale', 'stale or historically incomplete slices are withheld from dashboards until their evidence is resolved and rebuilt');
                    }
                    $projectionOrganizationId = trim((string) ($projection->organization_id ?? ''));
                    if ($projectionOrganizationId === '' || $projectionOrganizationId !== trim((string) $lockedDashboard->organization_id)) {
                        // Dashboards are organization-owned projections. A
                        // global/null or foreign snapshot cannot be pinned
                        // into one merely because its metric/scope key fits.
                        throw BusinessRejection::forCode('reporting.pin_scope_conflict', 'the computed projection organization does not match the dashboard');
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
                        'dashboard' => $lockedDashboard->id, 'organization_id' => $lockedDashboard->organization_id, 'metric' => $metricKey, 'period' => $periodKey,
                    ]);

                    return ['pin_id' => $pin->id, 'correlation_id' => $event->correlation_id];
                }),
            );
        } catch (AuthorizationDenied $denial) {
            $this->attemptedOperation->deniedByActor($denial, $actor, 'reporting.dashboard.pin', 'dashboard_pin', $dashboard->id);
        }
    }

    private function require(Actor $actor, ?string $organizationId = null): void
    {
        $scope = $organizationId === null ? null : StructureScope::organization($organizationId);
        $outcome = $this->access->decide($actor, self::CAPABILITY, $scope);
        if (! $outcome->allowed) {
            throw AuthorizationDenied::forCode('reporting.dashboard_denied', $outcome->reason);
        }
    }

    private function resolveOrganization(Actor $actor, ?string $organizationId): string
    {
        $organizationId = trim((string) ($organizationId ?? ''));
        if ($organizationId !== '') {
            $this->require($actor, $organizationId);
            if (! Organization::query()->whereKey($organizationId)->where('lifecycle_state', 'active')->exists()) {
                throw BusinessRejection::forCode('reporting.dashboard_organization_unknown', 'dashboard organization must be active');
            }

            return $organizationId;
        }

        $authorized = [];
        foreach (Organization::query()->where('lifecycle_state', 'active')->get(['id']) as $organization) {
            if ($this->access->decide($actor, self::CAPABILITY, StructureScope::organization((string) $organization->id))->allowed) {
                $authorized[] = (string) $organization->id;
            }
        }
        if (count($authorized) !== 1) {
            throw BusinessRejection::forCode('reporting.dashboard_organization_required', 'dashboard creation requires one explicit organization when the actor governs multiple organizations');
        }

        return $authorized[0];
    }
}
