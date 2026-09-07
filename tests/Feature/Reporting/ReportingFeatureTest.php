<?php

declare(strict_types=1);

namespace Tests\Feature\Reporting;

use App\Modules\Academic\Commands\MaintainAcademicStructure;
use App\Modules\Academic\Commands\MaintainClass;
use App\Modules\Academic\Commands\MaintainEnrollment;
use App\Modules\Academic\Commands\RecordAttendance;
use App\Modules\Academic\Models\AcademicPeriod;
use App\Modules\Academic\Models\ClassModel;
use App\Modules\Academic\Models\ClassSession;
use App\Modules\Academic\Models\Enrollment;
use App\Modules\Academic\Models\Program;
use App\Modules\Admissions\Commands\EnrollAdmittedApplicant;
use App\Modules\Admissions\Commands\RegisterApplicant;
use App\Modules\Admissions\Models\Applicant;
use App\Modules\Finance\Commands\AllocateFunds;
use App\Modules\Finance\Commands\AllocatePayment;
use App\Modules\Finance\Commands\MaintainDiscount;
use App\Modules\Finance\Commands\MaintainFinancialPeriod;
use App\Modules\Finance\Commands\PostObligation;
use App\Modules\Finance\Commands\RecordPayment;
use App\Modules\Finance\Models\Discount;
use App\Modules\Finance\Models\FinancialPeriod;
use App\Modules\Finance\Models\FundingSource;
use App\Modules\Finance\Models\Obligation;
use App\Modules\Finance\Models\ObligationLine;
use App\Modules\Finance\Models\Payment;
use App\Modules\Payroll\Commands\MaintainPayrollPeriod;
use App\Modules\Reporting\Commands\ComputeProjection;
use App\Modules\Reporting\Commands\DefineMetric;
use App\Modules\Reporting\Commands\MaintainDashboard;
use App\Modules\Reporting\Commands\ReconcileMetric;
use App\Modules\Reporting\Commands\RunReport;
use App\Modules\Reporting\Models\Dashboard;
use App\Modules\Reporting\Models\MetricDefinition;
use App\Modules\Reporting\Models\MetricVersion;
use App\Modules\Organization\Models\Organization;
use App\Support\Errors\AuthorizationDenied;
use App\Support\Errors\BusinessRejection;
use Carbon\CarbonImmutable;
use Illuminate\Database\QueryException;
use Illuminate\Support\Facades\DB;
use Tests\Concerns\BuildsActors;
use Tests\Concerns\DecidesAdmissions;
use Tests\TestCase;

final class ReportingFeatureTest extends TestCase
{
    use BuildsActors;
    use DecidesAdmissions;

    private string $financialPeriodKey = '2026-12';

    private string $studentId;

    private string $tuitionLineId;

    private string $classId;

    private string $academicPeriodId;

    public function test_finance_metrics_reconcile_with_authoritative_sources(): void
    {
        $this->seedFinancialChain();
        $analyst = $this->grantedActor('rep-analyst', ['reporting.catalog', 'reporting.compute', 'reporting.run', 'reporting.reconcile', 'reporting.dashboard']);

        // 8500 charged - 4000 allocated - 1000 discount = 3500 outstanding (fund coverage belongs to the funding test)
        $definition = app(DefineMetric::class)->define($analyst, 'student_outstanding_balance', 'Outstanding balance per student', 'obligations minus allocations, discounts, fund allocations', '2026-01-01', 'rep-def-1');
        $this->assertSame(1, $definition['version_no']);

        try {
            app(DefineMetric::class)->define($analyst, 'invented_kpi', 'Not Registered', 'x', '2026-01-01', 'rep-def-2');
            $this->fail('metrics outside the canonical catalog must be rejected');
        } catch (BusinessRejection $rejection) {
            $this->assertSame('reporting.metric_unknown', $rejection->errorCode());
        }

        try {
            app(ComputeProjection::class)->compute($analyst, 'student_outstanding_balance', '2099-01', 'student', $this->studentId, 'rep-pr-1');
            $this->fail('a period outside the metric period authority must be rejected');
        } catch (BusinessRejection $rejection) {
            $this->assertSame('reporting.period_unknown', $rejection->errorCode());
        }

        try {
            app(ComputeProjection::class)->compute($analyst, 'student_outstanding_balance', $this->financialPeriodKey, 'fund', 'x', 'rep-pr-2');
            $this->fail('scopes outside the metric declaration must be rejected');
        } catch (BusinessRejection $rejection) {
            $this->assertSame('reporting.scope_not_allowed', $rejection->errorCode());
        }

        $projection = app(ComputeProjection::class)->compute($analyst, 'student_outstanding_balance', $this->financialPeriodKey, 'student', $this->studentId, 'rep-pr-3');
        $this->assertSame('3500.00', $projection['value']);

        $reconciliation = app(ReconcileMetric::class)->reconcile($analyst, 'student_outstanding_balance', $this->financialPeriodKey, 'student', $this->studentId, 'rep-rec-1');
        $this->assertSame('matched', $reconciliation['status']);
        $this->assertSame('0.0000', $reconciliation['variance']);
        $this->assertDatabaseHas('metric_reconciliations', [
            'id' => $reconciliation['reconciliation_id'],
            'metric_projection_id' => $projection['projection_id'],
            'organization_id' => $this->bootstrapOrganizationId,
        ]);

        // Reconciliation is evidence about a particular complete projection,
        // not a free-form direct-SQL variance record.
        try {
            DB::table('metric_reconciliations')->insert([
                'id' => '00000000-0000-4000-8000-00000000r001',
                'metric_id' => MetricDefinition::query()->where('key', 'student_outstanding_balance')->value('id'),
                'period_key' => $this->financialPeriodKey,
                'scope_type' => 'student',
                'scope_id' => $this->studentId,
                'organization_id' => $this->bootstrapOrganizationId,
                'reported_value' => '3500.00',
                'authoritative_value' => '3500.00',
                'variance' => '0.0000',
                'status' => 'matched',
                'reconciled_by' => $analyst->actorId,
            ]);
            $this->fail('a reconciliation without its compared projection must be rejected');
        } catch (QueryException $exception) {
            $this->assertStringContainsString('metric reconciliation requires the compared current projection', $exception->getMessage());
        }

        // reconcile against a tampered projection -> divergence detected, source untouched
        DB::table('metric_projections')->where('id', $projection['projection_id'])->update(['value' => 9999]);
        $diverged = app(ReconcileMetric::class)->reconcile($analyst, 'student_outstanding_balance', $this->financialPeriodKey, 'student', $this->studentId, 'rep-rec-2');
        $this->assertSame('diverged', $diverged['status']);
        $this->assertSame('6499.0000', $diverged['variance']);

        $run = app(RunReport::class)->run($analyst, 'student_outstanding_balance', $this->financialPeriodKey, 'student', $this->studentId, ['min_amount' => '1'], 'rep-run-1');
        $this->assertSame('3500.00', $run['result']);
        $this->assertSame('complete', $run['completeness']);
        $this->assertDatabaseHas('report_runs', ['id' => $run['run_id'], 'completeness' => 'complete']);
        $this->assertSame(64, strlen($run['reproducibility_hash']));

        $this->expectException(QueryException::class);
        DB::statement('UPDATE report_runs SET result = 0 WHERE id = ?', [$run['run_id']]);
    }

    public function test_metric_versions_pin_history_and_mark_old_projections_stale(): void
    {
        $this->seedFinancialChain();
        $analyst = $this->grantedActor('rep-analyst', ['reporting.catalog', 'reporting.compute', 'reporting.run', 'reporting.reconcile', 'reporting.dashboard']);
        app(DefineMetric::class)->define($analyst, 'student_outstanding_balance', 'Outstanding balance per student', 'spec v1', '2026-01-01', 'rep-def-3');
        $projection = app(ComputeProjection::class)->compute($analyst, 'student_outstanding_balance', $this->financialPeriodKey, 'student', $this->studentId, 'rep-pr-4');

        $revision = app(DefineMetric::class)->revise($analyst, MetricDefinition::query()->where('key', 'student_outstanding_balance')->firstOrFail(), 'spec v2 excludes nothing', '2026-12-01', 'rep-def-4');
        $this->assertSame(2, $revision['version_no']);
        $metricId = DB::table('metric_definitions')->where('key', 'student_outstanding_balance')->value('id');
        $this->assertDatabaseHas('metric_projections', ['id' => $projection['projection_id'], 'completeness' => 'stale']);
        $this->assertDatabaseHas('metric_versions', ['metric_id' => $metricId, 'version_no' => 1, 'calculation_spec' => 'spec v1']);

        $this->expectException(QueryException::class);
        DB::statement('DELETE FROM metric_versions WHERE version_no = 1');
    }

    public function test_dashboard_pins_only_complete_current_projections(): void
    {
        $this->seedFinancialChain();
        $analyst = $this->grantedActor('rep-analyst', ['reporting.catalog', 'reporting.compute', 'reporting.run', 'reporting.reconcile', 'reporting.dashboard']);
        app(DefineMetric::class)->define($analyst, 'student_outstanding_balance', 'Outstanding balance per student', 'spec', '2026-01-01', 'rep-def-5');
        $dashboard = app(MaintainDashboard::class)->create($analyst, 'Finance Overview', 'rep-dash-1');

        try {
            app(MaintainDashboard::class)->pin($analyst, Dashboard::query()->findOrFail($dashboard['dashboard_id']), 'student_outstanding_balance', $this->financialPeriodKey, 'student', $this->studentId, 'rep-pin-1');
            $this->fail('pinning an uncomputed slice must be rejected');
        } catch (BusinessRejection $rejection) {
            $this->assertSame('reporting.pin_no_projection', $rejection->errorCode());
        }

        $projection = app(ComputeProjection::class)->compute($analyst, 'student_outstanding_balance', $this->financialPeriodKey, 'student', $this->studentId, 'rep-pr-5');
        app(MaintainDashboard::class)->pin($analyst, Dashboard::query()->findOrFail($dashboard['dashboard_id']), 'student_outstanding_balance', $this->financialPeriodKey, 'student', $this->studentId, 'rep-pin-2');

        try {
            app(MaintainDashboard::class)->pin($analyst, Dashboard::query()->findOrFail($dashboard['dashboard_id']), 'student_outstanding_balance', $this->financialPeriodKey, 'student', $this->studentId, 'rep-pin-3');
            $this->fail('double pinning must be rejected');
        } catch (BusinessRejection $rejection) {
            $this->assertSame('reporting.pin_exists', $rejection->errorCode());
        }

        // A dashboard belongs to an organization. It must not reinterpret a
        // platform-global slice as tenant-local even if a caller bypasses the
        // form and calls the command directly.
        try {
            app(MaintainDashboard::class)->pin($analyst, Dashboard::query()->findOrFail($dashboard['dashboard_id']), 'student_outstanding_balance', $this->financialPeriodKey, 'global', null, 'rep-pin-global-forbidden');
            $this->fail('organization-owned dashboards must reject global projections');
        } catch (BusinessRejection $rejection) {
            $this->assertSame('reporting.pin_global_scope_forbidden', $rejection->errorCode());
        }

        app(DefineMetric::class)->revise($analyst, MetricDefinition::query()->where('key', 'student_outstanding_balance')->firstOrFail(), 'spec v2', '2026-12-01', 'rep-def-6');
        try {
            app(MaintainDashboard::class)->pin($analyst, Dashboard::query()->findOrFail($dashboard['dashboard_id']), 'student_outstanding_balance', $this->financialPeriodKey, 'student', $this->studentId, 'rep-pin-4');
            $this->fail('pinning after revision without recomputation must be withheld');
        } catch (BusinessRejection $rejection) {
            $this->assertSame('reporting.pin_no_projection', $rejection->errorCode());
        }
        $this->assertDatabaseHas('metric_projections', ['id' => $projection['projection_id'], 'completeness' => 'stale']);
    }

    public function test_payroll_academic_and_funding_metrics_use_owner_period_authorities(): void
    {
        $this->seedAcademicChain();
        $analyst = $this->grantedActor('rep-analyst', ['reporting.catalog', 'reporting.compute', 'reporting.run', 'reporting.reconcile', 'reporting.dashboard']);

        // Payroll source evidence is not monetary reporting until Finance recognition.
        $payrollPeriod = app(MaintainPayrollPeriod::class)->open($this->grantedActor('rep-payroll-opener', ['payroll.period']), '2026-12-P', '2026-12-01', '2026-12-31', 'rep-pay-1');
        app(DefineMetric::class)->define($analyst, 'payroll_total', 'Approved payroll total', 'approved results plus adjustments', '2026-01-01', 'rep-def-7');
        $this->assertSame('0.00', app(ComputeProjection::class)->compute($analyst, 'payroll_total', '2026-12-P', 'global', null, 'rep-pr-6')['value'], 'empty payroll reconciles to zero');

        try {
            app(ComputeProjection::class)->compute($analyst, 'payroll_total', $this->financialPeriodKey, 'global', null, 'rep-pr-7');
            $this->fail('a payroll metric must not resolve a financial-period key');
        } catch (BusinessRejection $rejection) {
            $this->assertSame('reporting.period_unknown', $rejection->errorCode());
        }

        // enrollment: 2 active seats in the class
        app(DefineMetric::class)->define($analyst, 'active_enrollment_count', 'Active enrollments', 'active membership facts', '2026-01-01', 'rep-def-8');
        $this->assertSame('2', app(ComputeProjection::class)->compute($analyst, 'active_enrollment_count', $this->academicPeriodId, 'class', $this->classId, 'rep-pr-8')['value']);

        // attendance: 2 facts, 1 present -> 0.5000
        app(DefineMetric::class)->define($analyst, 'attendance_rate', 'Attendance rate', 'present share of recorded facts', '2026-01-01', 'rep-def-9');
        $this->assertSame('0.5000', app(ComputeProjection::class)->compute($analyst, 'attendance_rate', $this->academicPeriodId, 'class', $this->classId, 'rep-pr-9')['value']);

        // funding: 2500 of 10000 committed = 0.25 as-of the financial period end (obligation remainder is 3500)
        $fund = app(AllocateFunds::class)->establish($this->grantedActor('rep-fund-mgr', ['finance.fund']), $this->bootstrapOrganizationId, 'Rep Fund', 'agreement/rep-1', '10000.00', 'tuition', 'restricted to tuition', 'rep-fund-1');
        $fundAllocator = $this->grantedActor('rep-fund-alloc', ['finance.fund_allocate']);
        app(AllocateFunds::class)->allocate($fundAllocator, FundingSource::query()->findOrFail($fund['fund_id']), ObligationLine::query()->findOrFail($this->tuitionLineId), '2500.00', 'sponsor coverage', 'rep-fund-2');
        app(DefineMetric::class)->define($analyst, 'fund_utilization', 'Fund utilization', 'allocated over committed as-of period end', '2026-01-01', 'rep-def-10');
        $this->assertSame('0.2500', app(ComputeProjection::class)->compute($analyst, 'fund_utilization', $this->financialPeriodKey, 'fund', $fund['fund_id'], 'rep-pr-10')['value']);

        try {
            app(ComputeProjection::class)->compute($analyst, 'fund_utilization', $this->financialPeriodKey, 'fund', null, 'rep-pr-11');
            $this->fail('fund utilization without a fund scope must be rejected');
        } catch (BusinessRejection $rejection) {
            $this->assertSame('reporting.scope_shape', $rejection->errorCode());
        }
    }

    public function test_unprivileged_projection_is_denied_and_audited(): void
    {
        $this->seedFinancialChain();
        $this->grantedActor('rep-analyst', ['reporting.catalog', 'reporting.compute', 'reporting.run', 'reporting.reconcile', 'reporting.dashboard']);
        app(DefineMetric::class)->define($this->grantedActor('rep-analyst', ['reporting.catalog']), 'student_outstanding_balance', 'Outstanding balance per student', 'spec', '2026-01-01', 'rep-def-11');
        $nobody = $this->actorWithoutAnyCapability('rep-nobody');

        // authorization precedes validation: an unknown metric key must still be DENIED for an
        // unprivileged actor (capability first, catalog validation after, denial audited)
        try {
            app(DefineMetric::class)->define($nobody, 'invented_kpi', 'X', 'spec', '2026-01-01', 'rep-neg-2');
            $this->fail('an unprivileged actor must be denied before metric validation runs');
        } catch (AuthorizationDenied) {
            $this->assertDatabaseHas('audit_events', ['operation' => 'reporting.metric.define.denied', 'actor_id' => 'rep-nobody']);
        }

        $this->expectException(AuthorizationDenied::class);
        app(ComputeProjection::class)->compute($nobody, 'student_outstanding_balance', $this->financialPeriodKey, 'student', $this->studentId, 'rep-neg-1');

        $this->assertDatabaseHas('audit_events', ['operation' => 'reporting.projection.compute.denied', 'actor_id' => 'rep-nobody']);
        $this->assertDatabaseMissing('metric_projections', ['period_key' => $this->financialPeriodKey]);
    }

    public function test_fund_reporting_and_dashboard_boundaries_follow_the_finance_source_organization(): void
    {
        $this->seedFinancialChain();
        $localAnalyst = $this->grantedActor('rep-local-analyst', [
            'reporting.catalog', 'reporting.compute', 'reporting.run', 'reporting.reconcile', 'reporting.dashboard',
        ]);
        app(DefineMetric::class)->define(
            $localAnalyst,
            'fund_utilization',
            'Finance fund utilization',
            'Finance allocations over committed amount',
            '2026-01-01',
            'rep-fund-scope-definition',
        );
        /** @var MetricDefinition $metric */
        $metric = MetricDefinition::query()->where('key', 'fund_utilization')->firstOrFail();
        /** @var MetricVersion $version */
        $version = MetricVersion::query()->where('metric_id', $metric->id)->where('version_no', 1)->firstOrFail();

        /** @var Organization $otherOrganization */
        $otherOrganization = Organization::query()->create([
            'id' => '00000000-0000-4000-8000-00000000f167',
            'name' => 'Foreign Reporting Fund Organization',
            'lifecycle_state' => 'active',
        ]);
        $fundManager = $this->grantedActor('rep-foreign-fund-manager', ['finance.fund']);
        $this->grantScopeAuthority($fundManager->actorId, ['finance.fund'], 'organization', $otherOrganization->id);
        $fund = app(AllocateFunds::class)->establish(
            $fundManager,
            $otherOrganization->id,
            'Foreign reporting fund',
            'agreement/foreign-reporting',
            '1000.00',
            null,
            null,
            'rep-fund-scope-establish',
        );

        // An analyst who can report in the bootstrap organization cannot turn
        // a foreign fund identifier into a cross-organization projection,
        // report, or reconciliation oracle.
        foreach ([
            fn () => app(ComputeProjection::class)->compute($localAnalyst, 'fund_utilization', $this->financialPeriodKey, 'fund', $fund['fund_id'], 'rep-fund-scope-local-compute'),
            fn () => app(RunReport::class)->run($localAnalyst, 'fund_utilization', $this->financialPeriodKey, 'fund', $fund['fund_id'], [], 'rep-fund-scope-local-run'),
            fn () => app(ReconcileMetric::class)->reconcile($localAnalyst, 'fund_utilization', $this->financialPeriodKey, 'fund', $fund['fund_id'], 'rep-fund-scope-local-reconcile'),
        ] as $attempt) {
            try {
                $attempt();
                $this->fail('fund reporting must be authorized against the source organization, not any organization');
            } catch (AuthorizationDenied $denial) {
                $this->assertSame('reporting.scope_denied', $denial->errorCode());
            }
        }

        // Bypass attempts carry real definition/version/source references and
        // only forge the organization snapshot. Their exact schema guards
        // prove that neither reporting table accepts cross-tenant fund facts.
        try {
            DB::table('metric_projections')->insert([
                'id' => '00000000-0000-4000-8000-00000000f168',
                'metric_version_id' => $version->id,
                'period_key' => $this->financialPeriodKey,
                'scope_type' => 'fund',
                'scope_id' => $fund['fund_id'],
                'organization_id' => $this->bootstrapOrganizationId,
                'value' => '0.0000',
                'completeness' => 'complete',
                'meta' => json_encode([]),
                'computed_at' => now(),
                'computed_by' => 'direct-sql-attacker',
                'created_at' => now(),
                'updated_at' => now(),
            ]);
            $this->fail('raw SQL must not assign organization-A provenance to an organization-B fund projection');
        } catch (QueryException $exception) {
            $this->assertStringContainsString('fund metric projection organization must match its funding source', $exception->getMessage());
        }
        try {
            DB::table('report_runs')->insert([
                'id' => '00000000-0000-4000-8000-00000000f169',
                'metric_version_id' => $version->id,
                'period_key' => $this->financialPeriodKey,
                'scope_type' => 'fund',
                'scope_id' => $fund['fund_id'],
                'organization_id' => $this->bootstrapOrganizationId,
                'filters' => json_encode([]),
                'result' => '0.0000',
                'completeness' => 'complete',
                'meta' => json_encode([]),
                'reproducibility_hash' => hash('sha256', 'forged foreign fund run'),
                'executed_by' => 'direct-sql-attacker',
                'created_at' => now(),
                'updated_at' => now(),
            ]);
            $this->fail('raw SQL must not assign organization-A provenance to an organization-B fund run');
        } catch (QueryException $exception) {
            $this->assertStringContainsString('fund report run organization must match its funding source', $exception->getMessage());
        }

        $foreignAnalyst = $this->grantedActor('rep-foreign-analyst', ['reporting.compute', 'reporting.run', 'reporting.reconcile']);
        $this->grantScopeAuthority($foreignAnalyst->actorId, ['reporting.compute', 'reporting.run', 'reporting.reconcile'], 'organization', $otherOrganization->id);
        $projection = app(ComputeProjection::class)->compute($foreignAnalyst, 'fund_utilization', $this->financialPeriodKey, 'fund', $fund['fund_id'], 'rep-fund-scope-foreign-compute');
        $run = app(RunReport::class)->run($foreignAnalyst, 'fund_utilization', $this->financialPeriodKey, 'fund', $fund['fund_id'], [], 'rep-fund-scope-foreign-run');
        $reconciliation = app(ReconcileMetric::class)->reconcile($foreignAnalyst, 'fund_utilization', $this->financialPeriodKey, 'fund', $fund['fund_id'], 'rep-fund-scope-foreign-reconcile');
        $this->assertSame('matched', $reconciliation['status']);
        $this->assertDatabaseHas('metric_projections', ['id' => $projection['projection_id'], 'organization_id' => $otherOrganization->id]);
        $this->assertDatabaseHas('report_runs', ['id' => $run['run_id'], 'organization_id' => $otherOrganization->id]);

        // A dashboard is an organization-owned projection surface. Even a
        // complete source-B projection cannot be pinned into dashboard A.
        $dashboard = app(MaintainDashboard::class)->create($localAnalyst, 'Local dashboard', 'rep-fund-scope-dashboard');
        try {
            DB::table('dashboard_pins')->insert([
                'id' => '00000000-0000-4000-8000-00000000f16a',
                'dashboard_id' => $dashboard['dashboard_id'],
                'metric_id' => $metric->id,
                'period_key' => $this->financialPeriodKey,
                'scope_type' => 'global',
                'scope_id' => null,
                'pinned_by' => 'direct-sql-attacker',
                'created_at' => now(),
                'updated_at' => now(),
            ]);
            $this->fail('raw SQL must not pin a platform-global projection into an organization dashboard');
        } catch (QueryException $exception) {
            $this->assertStringContainsString('organization-owned dashboards cannot pin global projections', $exception->getMessage());
        }
        try {
            app(MaintainDashboard::class)->pin($localAnalyst, Dashboard::query()->findOrFail($dashboard['dashboard_id']), 'fund_utilization', $this->financialPeriodKey, 'fund', $fund['fund_id'], 'rep-fund-scope-pin-command');
            $this->fail('an organization-A dashboard must not pin an organization-B fund projection');
        } catch (BusinessRejection $rejection) {
            $this->assertSame('reporting.pin_scope_conflict', $rejection->errorCode());
        }
        try {
            DB::table('dashboard_pins')->insert([
                'id' => '00000000-0000-4000-8000-00000000f170',
                'dashboard_id' => $dashboard['dashboard_id'],
                'metric_id' => $metric->id,
                'period_key' => $this->financialPeriodKey,
                'scope_type' => 'fund',
                'scope_id' => $fund['fund_id'],
                'pinned_by' => 'direct-sql-attacker',
                'created_at' => now(),
                'updated_at' => now(),
            ]);
            $this->fail('raw SQL must not pin a foreign organization projection');
        } catch (QueryException $exception) {
            $this->assertStringContainsString('dashboard pins require a complete projection matching the dashboard organization', $exception->getMessage());
        }
    }

    private function seedFinancialChain(): void
    {
        $clerk = $this->grantedActor('rep-fin-clerk', ['finance.period', 'finance.obligation', 'finance.payment', 'finance.discount', 'finance.discount_approve', 'finance.fund']);
        $period = app(MaintainFinancialPeriod::class)->open($clerk, $this->financialPeriodKey, '2026-12-01', '2026-12-31', 'rep-fin-per-1');

        $this->personWithAuthority('rep-person-1', []);
        $registered = app(RegisterApplicant::class)->register($this->admissionsClerk('rep-adm-clerk'), 'rep-person-1', 'Program', 'rep-reg-1');
        /** @var Applicant $applicant */
        $applicant = Applicant::query()->findOrFail($registered['applicant_id']);
        $this->runAdmissionDecision($this->admissionsClerk('rep-adm-clerk'), $this->admissionsReviewer('rep-adm-rev'), $this->admissionsApprover('rep-adm-appr'), $applicant, true, 'meets policy', 'ev/rep', 'rep-adm-1');
        $this->studentId = app(EnrollAdmittedApplicant::class)->convert($this->admissionsApprover('rep-adm-appr'), $applicant, 'rep-conv-1')['student_id'];

        $obligation = app(PostObligation::class)->post($clerk, FinancialPeriod::query()->findOrFail($period['period_id']), $this->studentId, 'tuition', 'December tuition', [
            ['category' => 'tuition', 'amount' => '8000.00', 'source_ref' => 'price-list/v3'],
            ['category' => 'transport', 'amount' => '500.00', 'source_ref' => 'price-list/v3'],
        ], 'rep-ob-1');
        $this->tuitionLineId = (string) ObligationLine::query()->where('obligation_id', $obligation['obligation_id'])->where('category', 'tuition')->value('id');

        $payment = app(RecordPayment::class)->record($clerk, FinancialPeriod::query()->findOrFail($period['period_id']), $this->studentId, '6000.00', 'bank-transfer', 'RCPT-REP-1', '2026-12-05', 'rep-pay-rec-1');
        app(AllocatePayment::class)->allocate($clerk, Payment::query()->findOrFail($payment['payment_id']), Obligation::query()->findOrFail($obligation['obligation_id']), '4000.00', 'rep-all-1');

        $discount = app(MaintainDiscount::class)->propose($clerk, Obligation::query()->findOrFail($obligation['obligation_id']), FinancialPeriod::query()->findOrFail($period['period_id']), '1000.00', 'policy/rep', '2026-12-01', null, 'rep discount', 'rep-dis-1');
        app(MaintainDiscount::class)->approve($this->grantedActor('rep-dis-appr', ['finance.discount_approve']), Discount::query()->findOrFail($discount['discount_id']), 'rep-dis-2');
    }

    private function seedAcademicChain(): void
    {
        $this->seedFinancialChain();
        $officer = $this->academicOfficer('rep-acad-officer');
        $program = app(MaintainAcademicStructure::class)->defineProgram($officer, 'Reporting Program', 'rep-prog-1');
        $version = app(MaintainAcademicStructure::class)->publishVersion($officer, Program::query()->findOrFail($program['program_id']), 'v1', 'rep-prog-2');
        $period = app(MaintainAcademicStructure::class)->definePeriod($officer, 'Reporting Term', new CarbonImmutable('2026-12-01'), new CarbonImmutable('2027-03-18'), 'rep-period-1');
        app(MaintainAcademicStructure::class)->transitionPeriod($officer, AcademicPeriod::query()->findOrFail($period['period_id']), 'published', 'rep-period-2');
        $this->academicPeriodId = $period['period_id'];
        $class = app(MaintainClass::class)->defineClass($officer, $version['version_id'], $period['period_id'], 5, 'rep-class-1');
        $this->classId = $class['class_id'];
        $this->personWithAuthority('rep-teacher-1', []);
        app(MaintainClass::class)->assignTeacher($officer, ClassModel::query()->findOrFail($this->classId), 'rep-teacher-1', new CarbonImmutable('2026-12-05'), null, 'rep-class-2');
        app(MaintainClass::class)->transition($officer, ClassModel::query()->findOrFail($this->classId), 'published', 'rep-class-3');
        app(MaintainClass::class)->transition($officer, ClassModel::query()->findOrFail($this->classId), 'active', 'rep-class-4');

        foreach (['rep-person-2', 'rep-person-3'] as $i => $personId) {
            $this->personWithAuthority($personId, []);
            $registered = app(RegisterApplicant::class)->register($this->admissionsClerk('rep-adm-clerk'), $personId, 'Program', 'rep-reg-'.($i + 2));
            /** @var Applicant $applicant */
            $applicant = Applicant::query()->findOrFail($registered['applicant_id']);
            $this->runAdmissionDecision($this->admissionsClerk('rep-adm-clerk'), $this->admissionsReviewer('rep-adm-rev'), $this->admissionsApprover('rep-adm-appr'), $applicant, true, 'meets policy', 'ev/rep'.$i, 'rep-adm-'.($i + 2));
            $studentId = app(EnrollAdmittedApplicant::class)->convert($this->admissionsApprover('rep-adm-appr'), $applicant, 'rep-conv-'.($i + 2))['student_id'];
            $seat = app(MaintainEnrollment::class)->request($this->enrollmentClerk('rep-enr-clerk'), $studentId, $this->classId, 'rep-enr-'.($i + 1));
            app(MaintainEnrollment::class)->activate($officer, Enrollment::query()->findOrFail($seat['enrollment_id']), 'rep-enr-a-'.($i + 1));
        }

        $session = app(MaintainClass::class)->scheduleSession($officer, ClassModel::query()->findOrFail($this->classId), new CarbonImmutable('2026-12-10'), '09:00', '11:00', 'rep-sess-1');
        $enrollmentIds = Enrollment::query()->where('class_id', $this->classId)->where('lifecycle_state', 'active')->pluck('id');
        $statuses = ['present', 'absent'];
        foreach ($enrollmentIds as $i => $enrollmentId) {
            /** @var Enrollment $enrollment */
            $enrollment = Enrollment::query()->findOrFail($enrollmentId);
            app(RecordAttendance::class)->record($officer, ClassSession::query()->findOrFail($session['session_id']), $enrollment, $statuses[$i], 'rep-att-'.$i);
        }
    }
}
