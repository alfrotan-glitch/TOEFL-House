<?php

declare(strict_types=1);

namespace App\Http\Controllers;

use App\Modules\Reporting\Commands\MaintainDashboard;
use App\Modules\Reporting\Commands\RunReport;
use App\Modules\Reporting\Domain\MetricCatalog;
use App\Modules\Reporting\Models\Dashboard;
use App\Modules\Reporting\Models\MetricDefinition;
use App\Modules\Organization\Models\Branch;
use App\Modules\Academic\Models\ClassModel;
use App\Modules\Students\Models\Student;
use App\Modules\Reporting\Models\ReportRun;
use App\Support\Errors\BusinessRejection;
use Illuminate\Http\RedirectResponse;
use Illuminate\Http\Request;
use Illuminate\Database\Eloquent\ModelNotFoundException;
use Illuminate\View\View;

/**
 * Reporting console: the metric catalog, reproducible report runs, and
 * dashboards. Runs delegate to the reporting command, which resolves the
 * metric to a single authoritative source, applies deterministic period
 * semantics, and stamps a reproducibility hash. Dashboards pin existing
 * metric definitions — they never hold a second truth.
 */
final class ReportingController extends Controller
{
    public function index(): View
    {
        $this->requireOrganizationRead('reporting.run', 'reporting.console.index');

        // Definitions with legacy-unresolved lineage are retained as evidence
        // in the database but must never be offered as live Reporting facts.
        // Every command fails closed too; this read model preserves the same
        // authority boundary rather than presenting an unusable/bypassable
        // catalog entry in the console.
        $metrics = $this->resolvedMetrics();
        $metricIds = $metrics->pluck('id')->all();
        $dashboardOrganizationIds = $this->authorizedOrganizations('reporting.dashboard');
        $runOrganizationIds = $this->authorizedOrganizations('reporting.run');
        $branchOrganizations = [];
        foreach (Branch::query()->whereIn('id', $this->authorizedBranches('reporting.run'))->get() as $branch) {
            try {
                $scope = $branch->structureScope();
            } catch (ModelNotFoundException) {
                continue;
            }
            $organizationId = trim((string) $scope->organizationId);
            if ($organizationId !== '') {
                $branchOrganizations[(string) $branch->id] = $organizationId;
            }
        }

        // A run's snapshot is part of its audit evidence. Build the same
        // concrete target/organization pairs that ReportingScope authorizes
        // rather than exposing every row in an organization just because a
        // current actor has some reporting authority there.
        $studentOrganizations = Student::query()
            ->where(function ($query) use ($branchOrganizations): void {
                $branchIds = array_keys($branchOrganizations);
                $query->whereIn('current_home_branch_id', $branchIds)
                    ->orWhere(function ($query) use ($branchIds): void {
                        $query->whereNull('current_home_branch_id')->whereIn('originating_branch_id', $branchIds);
                    });
            })
            ->get(['id', 'current_home_branch_id', 'originating_branch_id'])
            ->mapWithKeys(static function (Student $student) use ($branchOrganizations): array {
                $branchId = trim((string) ($student->current_home_branch_id ?: $student->originating_branch_id));

                return isset($branchOrganizations[$branchId]) ? [(string) $student->id => $branchOrganizations[$branchId]] : [];
            })
            ->all();
        $classOrganizations = ClassModel::query()
            ->whereIn('branch_id', array_keys($branchOrganizations))
            ->get(['id', 'branch_id'])
            ->mapWithKeys(static function (ClassModel $class) use ($branchOrganizations): array {
                $branchId = trim((string) $class->branch_id);

                return isset($branchOrganizations[$branchId]) ? [(string) $class->id => $branchOrganizations[$branchId]] : [];
            })
            ->all();
        $scopedOrganizations = [
            'branch' => $branchOrganizations,
            'student' => $studentOrganizations,
            'class' => $classOrganizations,
        ];
        $runs = ReportRun::query()
            ->leftJoin('metric_versions as mv', 'mv.id', '=', 'report_runs.metric_version_id')
            ->leftJoin('metric_definitions as md', 'md.id', '=', 'mv.metric_id')
            ->where(function ($visible) use ($scopedOrganizations, $runOrganizationIds): void {
                $firstScope = true;
                foreach ($scopedOrganizations as $scopeType => $targets) {
                    foreach ($targets as $scopeId => $organizationId) {
                        $method = $firstScope ? 'where' : 'orWhere';
                        $visible->{$method}(function ($pair) use ($scopeType, $scopeId, $organizationId): void {
                            $pair->where('report_runs.scope_type', $scopeType)
                                ->where('report_runs.scope_id', $scopeId)
                                ->where('report_runs.organization_id', $organizationId);
                        });
                        $firstScope = false;
                    }
                }
                if ($runOrganizationIds !== []) {
                    $method = $firstScope ? 'where' : 'orWhere';
                    $visible->{$method}(function ($fund) use ($runOrganizationIds): void {
                        $fund->where('report_runs.scope_type', 'fund')
                            ->whereIn('report_runs.organization_id', $runOrganizationIds)
                            // Do not surface a historical unknown/wrong fund
                            // snapshot. It remains immutable audit evidence,
                            // but cannot be treated as an authorized view.
                            ->whereExists(function ($source): void {
                                $source->selectRaw('1')
                                    ->from('funding_sources as fs')
                                    ->whereColumn('fs.id', 'report_runs.scope_id')
                                    ->whereColumn('fs.organization_id', 'report_runs.organization_id');
                            });
                    });
                    $firstScope = false;
                }
                if ($firstScope) {
                    $visible->whereRaw('1 = 0');
                }
            })
            ->whereIn('md.id', $metricIds)
            ->select('report_runs.*', 'md.key as metric_key', 'md.name as metric_name')
            ->orderByDesc('report_runs.created_at')
            ->limit(200)
            ->get();

        return view('reporting.index', [
            'metrics' => $metrics,
            'runs' => $runs,
            'dashboards' => Dashboard::query()->whereIn('organization_id', $dashboardOrganizationIds)->orderBy('name')->get(),
            'dashboard_organizations' => $dashboardOrganizationIds,
        ]);
    }

    /** @return \Illuminate\Support\Collection<int, MetricDefinition> */
    private function resolvedMetrics(): \Illuminate\Support\Collection
    {
        return MetricDefinition::query()->orderBy('key')->get()->filter(static function (MetricDefinition $metric): bool {
            try {
                MetricCatalog::assertDefinitionLineage($metric, MetricCatalog::entry((string) $metric->key));

                return true;
            } catch (BusinessRejection) {
                // Preserve unresolved legacy claims in storage/audit only;
                // they have no live calculation authority or console surface.
                return false;
            }
        })->values();
    }

    public function runReport(Request $request): RedirectResponse
    {
        $input = $request->validate([
            'metric_key' => ['required', 'string', 'max:120'],
            'period_key' => ['required', 'string', 'max:60'],
            'scope_type' => ['required', 'string', 'max:40'],
            'scope_id' => ['nullable', 'string'],
        ]);

        app(RunReport::class)->run(
            $this->actor(),
            $input['metric_key'],
            $input['period_key'],
            $input['scope_type'],
            $input['scope_id'] !== null && $input['scope_id'] !== '' ? $input['scope_id'] : null,
            [],
            $this->idempotencyKey('reporting.run'),
        );

        return redirect()->route('reporting.index')->with('success', 'Report run executed and recorded with a reproducibility hash.');
    }

    public function createDashboard(Request $request): RedirectResponse
    {
        $input = $request->validate([
            'name' => ['required', 'string', 'max:160'],
            'organization_id' => ['nullable', 'string'],
        ]);

        app(MaintainDashboard::class)->create(
            $this->actor(),
            $input['name'],
            $this->idempotencyKey('reporting.dashboard'),
            $input['organization_id'] ?? null,
        );

        return redirect()->route('reporting.index')->with('success', 'Dashboard created. Pin metrics to it.');
    }

    public function pinDashboard(Request $request, string $dashboardId): RedirectResponse
    {
        $input = $request->validate([
            'metric_key' => ['required', 'string', 'max:120'],
            'period_key' => ['required', 'string', 'max:60'],
            // Dashboards are tenant-owned; global projections are intentionally
            // platform-only and cannot be pinned into an organization view.
            'scope_type' => ['required', 'string', 'max:40', 'not_in:global'],
            'scope_id' => ['nullable', 'string'],
        ]);

        app(MaintainDashboard::class)->pin(
            $this->actor(),
            Dashboard::query()->findOrFail($dashboardId),
            $input['metric_key'],
            $input['period_key'],
            $input['scope_type'],
            $input['scope_id'] !== null && $input['scope_id'] !== '' ? $input['scope_id'] : null,
            $this->idempotencyKey('reporting.pin'),
        );

        return redirect()->route('reporting.index')->with('success', 'Metric pinned to the dashboard.');
    }
}
