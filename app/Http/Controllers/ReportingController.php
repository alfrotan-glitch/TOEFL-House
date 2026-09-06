<?php

declare(strict_types=1);

namespace App\Http\Controllers;

use App\Modules\Reporting\Commands\MaintainDashboard;
use App\Modules\Reporting\Commands\RunReport;
use App\Modules\Reporting\Models\Dashboard;
use App\Modules\Reporting\Models\MetricDefinition;
use App\Modules\Reporting\Models\ReportRun;
use Illuminate\Http\RedirectResponse;
use Illuminate\Http\Request;
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
        $runs = ReportRun::query()
            ->leftJoin('metric_versions as mv', 'mv.id', '=', 'report_runs.metric_version_id')
            ->leftJoin('metric_definitions as md', 'md.id', '=', 'mv.metric_id')
            ->select('report_runs.*', 'md.key as metric_key', 'md.name as metric_name')
            ->orderByDesc('report_runs.created_at')
            ->limit(200)
            ->get();

        return view('reporting.index', [
            'metrics' => MetricDefinition::query()->orderBy('key')->get(),
            'runs' => $runs,
            'dashboards' => Dashboard::query()->orderBy('name')->get(),
        ]);
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
        ]);

        app(MaintainDashboard::class)->create(
            $this->actor(),
            $input['name'],
            $this->idempotencyKey('reporting.dashboard'),
        );

        return redirect()->route('reporting.index')->with('success', 'Dashboard created. Pin metrics to it.');
    }

    public function pinDashboard(Request $request, string $dashboardId): RedirectResponse
    {
        $input = $request->validate([
            'metric_key' => ['required', 'string', 'max:120'],
            'period_key' => ['required', 'string', 'max:60'],
            'scope_type' => ['required', 'string', 'max:40'],
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
