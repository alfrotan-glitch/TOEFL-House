<?php

declare(strict_types=1);

namespace Tests\Feature\Finance;

use App\Modules\Finance\Commands\MaintainFinancialCredit;
use App\Modules\Finance\Commands\MaintainInstallmentPlan;
use App\Modules\Finance\Commands\PostObligation;
use App\Modules\Finance\Commands\RevokeFinancialCoverage;
use App\Modules\Finance\Models\EnrollmentInstallmentPlan;
use App\Modules\Finance\Models\FinancialCoverageCommitment;
use App\Modules\Finance\Models\FinancialCoverageRevocation;
use App\Modules\Finance\Models\FinancialCredit;
use App\Modules\Finance\Models\FinancialPeriod;
use App\Modules\Finance\Models\Obligation;
use App\Modules\Finance\Queries\FinancialGateQuery;
use App\Support\Errors\AuthorizationDenied;
use App\Support\Errors\BusinessRejection;
use App\Support\Identifiers\RandomIdentifier;
use Illuminate\Database\QueryException;
use Illuminate\Support\Facades\DB;
use Tests\Concerns\BuildsStudents;
use Tests\TestCase;

/**
 * Finance gate coverage must be attributed to immutable obligations rather
 * than repeatedly approving the same aggregate student remainder.
 */
final class FinancialCoverageCommitmentFeatureTest extends TestCase
{
    use BuildsStudents;

    private string $studentId;

    private FinancialPeriod $period;

    private Obligation $obligation;

    protected function setUp(): void
    {
        parent::setUp();
        $this->studentId = (string) $this->makeStudent([
            'initiator' => 'coverage-adm-init',
            'reviewer' => 'coverage-adm-review',
            'approver' => 'coverage-adm-approve',
        ])['student']->id;
        $this->period = FinancialPeriod::query()->create([
            'id' => RandomIdentifier::new(),
            'period_key' => 'coverage-'.substr(md5(RandomIdentifier::new()), 0, 10),
            'date_from' => '2026-09-01',
            'date_to' => '2026-09-30',
            'lifecycle_state' => 'open',
        ]);
        $poster = $this->grantedActor('coverage-obligation-poster', ['finance.obligation']);
        $posted = app(PostObligation::class)->post($poster, $this->period, $this->studentId, 'tuition', 'coverage fixture', [
            ['category' => 'tuition', 'amount' => '100.00', 'source_ref' => 'coverage-fixture-source'],
        ], 'coverage-obligation-post');
        $this->obligation = Obligation::query()->findOrFail($posted['obligation_id']);
    }

    public function test_approval_materializes_exact_commitments_and_blocks_competing_coverage(): void
    {
        $creditProposer = $this->grantedActor('coverage-credit-proposer', ['finance.credit']);
        $creditApprover = $this->grantedActor('coverage-credit-approver', ['finance.credit_approve']);
        $proposedCredit = app(MaintainFinancialCredit::class)->propose(
            $creditProposer,
            $this->studentId,
            '60.00',
            'verified advance',
            'coverage-credit-source',
            'coverage-credit-propose',
        );
        app(MaintainFinancialCredit::class)->approve(
            $creditApprover,
            FinancialCredit::query()->findOrFail($proposedCredit['credit_id']),
            'coverage-credit-approve',
        );

        $this->assertDatabaseHas('financial_coverage_commitments', [
            'coverage_source_type' => FinancialCoverageCommitment::SOURCE_FINANCIAL_CREDIT,
            'coverage_source_id' => $proposedCredit['credit_id'],
            'obligation_id' => $this->obligation->id,
            'amount' => '60.00',
        ]);
        $assessment = app(FinancialGateQuery::class)->assessStudent($this->studentId);
        $this->assertSame('60.00', $assessment['evidence']['coverage']['credit']);
        $this->assertSame('40.00', $assessment['remaining']);

        $planProposer = $this->grantedActor('coverage-plan-proposer', ['finance.installment']);
        $planApprover = $this->grantedActor('coverage-plan-approver', ['finance.installment_approve']);
        $proposedPlan = app(MaintainInstallmentPlan::class)->propose(
            $planProposer,
            $this->studentId,
            null,
            '50.00',
            2,
            '2026-09-15',
            'coverage-plan-source',
            'coverage-plan-propose',
        );

        try {
            app(MaintainInstallmentPlan::class)->approve(
                $planApprover,
                EnrollmentInstallmentPlan::query()->findOrFail($proposedPlan['plan_id']),
                'coverage-plan-approve',
            );
            $this->fail('a second source cannot re-use coverage already committed by the first source');
        } catch (BusinessRejection $rejection) {
            $this->assertSame('finance.installment_exceeds_uncovered', $rejection->errorCode());
        }
        $this->assertDatabaseHas('enrollment_installment_plans', [
            'id' => $proposedPlan['plan_id'],
            'lifecycle_state' => EnrollmentInstallmentPlan::STATE_PROPOSED,
        ]);
        $this->assertSame(1, FinancialCoverageCommitment::query()->count());
    }

    public function test_revocation_preserves_source_history_and_removes_it_from_future_gate_coverage(): void
    {
        $creditProposer = $this->grantedActor('coverage-revoke-credit-proposer', ['finance.credit']);
        $creditApprover = $this->grantedActor('coverage-revoke-credit-approver', ['finance.credit_approve']);
        $credit = app(MaintainFinancialCredit::class)->propose(
            $creditProposer,
            $this->studentId,
            '100.00',
            'verified advance',
            'coverage-revoke-credit-source',
            'coverage-revoke-credit-propose',
        );
        app(MaintainFinancialCredit::class)->approve(
            $creditApprover,
            FinancialCredit::query()->findOrFail($credit['credit_id']),
            'coverage-revoke-credit-approve',
        );
        $this->assertSame('0.00', app(FinancialGateQuery::class)->assessStudent($this->studentId)['remaining']);

        $requester = $this->grantedActor('coverage-revoke-requester', ['finance.coverage_revoke']);
        $approver = $this->grantedActor('coverage-revoke-approver', ['finance.coverage_revoke_approve']);
        $proposal = app(RevokeFinancialCoverage::class)->propose(
            $requester,
            FinancialCoverageCommitment::SOURCE_FINANCIAL_CREDIT,
            $credit['credit_id'],
            'source evidence superseded',
            'coverage-revoke-propose',
        );
        app(RevokeFinancialCoverage::class)->approve(
            $approver,
            FinancialCoverageRevocation::query()->findOrFail($proposal['revocation_id']),
            'coverage-revoke-approve',
        );

        $this->assertDatabaseHas('financial_credits', [
            'id' => $credit['credit_id'],
            'lifecycle_state' => FinancialCredit::STATE_APPROVED,
        ]);
        $this->assertDatabaseHas('financial_coverage_revocations', [
            'id' => $proposal['revocation_id'],
            'lifecycle_state' => FinancialCoverageRevocation::STATE_RECORDED,
        ]);
        $assessment = app(FinancialGateQuery::class)->assessStudent($this->studentId);
        $this->assertSame('0.00', $assessment['evidence']['coverage']['credit']);
        $this->assertSame('100.00', $assessment['remaining']);

        // The recorded correction releases only future authorization capacity;
        // it does not delete the old source or commitment history.
        $replacement = app(MaintainFinancialCredit::class)->propose(
            $creditProposer,
            $this->studentId,
            '100.00',
            'replacement evidence',
            'coverage-revoke-credit-replacement-source',
            'coverage-revoke-credit-replacement-propose',
        );
        app(MaintainFinancialCredit::class)->approve(
            $creditApprover,
            FinancialCredit::query()->findOrFail($replacement['credit_id']),
            'coverage-revoke-credit-replacement-approve',
        );
        $this->assertSame(2, FinancialCoverageCommitment::query()->count());
        $replacementAssessment = app(FinancialGateQuery::class)->assessStudent($this->studentId);
        $this->assertSame('100.00', $replacementAssessment['evidence']['coverage']['credit']);
        $this->assertSame('0.00', $replacementAssessment['remaining']);
    }

    public function test_revocation_requires_an_independent_finance_approver(): void
    {
        $creditProposer = $this->grantedActor('coverage-revoke-sod-credit-proposer', ['finance.credit']);
        $creditApprover = $this->grantedActor('coverage-revoke-sod-credit-approver', ['finance.credit_approve']);
        $credit = app(MaintainFinancialCredit::class)->propose(
            $creditProposer,
            $this->studentId,
            '25.00',
            'verified advance',
            'coverage-revoke-sod-credit-source',
            'coverage-revoke-sod-credit-propose',
        );
        app(MaintainFinancialCredit::class)->approve(
            $creditApprover,
            FinancialCredit::query()->findOrFail($credit['credit_id']),
            'coverage-revoke-sod-credit-approve',
        );
        $dualRoleActor = $this->grantedActor('coverage-revoke-sod-dual-role', [
            'finance.coverage_revoke',
            'finance.coverage_revoke_approve',
        ]);
        $proposal = app(RevokeFinancialCoverage::class)->propose(
            $dualRoleActor,
            FinancialCoverageCommitment::SOURCE_FINANCIAL_CREDIT,
            $credit['credit_id'],
            'independence fixture',
            'coverage-revoke-sod-propose',
        );

        try {
            app(RevokeFinancialCoverage::class)->approve(
                $dualRoleActor,
                FinancialCoverageRevocation::query()->findOrFail($proposal['revocation_id']),
                'coverage-revoke-sod-approve',
            );
            $this->fail('a requester must not record their own coverage-source revocation');
        } catch (AuthorizationDenied $denial) {
            $this->assertSame('finance.coverage_revocation_not_independent', $denial->errorCode());
        }
        $this->assertDatabaseHas('financial_coverage_revocations', [
            'id' => $proposal['revocation_id'],
            'lifecycle_state' => FinancialCoverageRevocation::STATE_PROPOSED,
        ]);
    }

    public function test_database_rejects_a_directly_recorded_coverage_revocation(): void
    {
        $creditProposer = $this->grantedActor('coverage-revoke-db-credit-proposer', ['finance.credit']);
        $creditApprover = $this->grantedActor('coverage-revoke-db-credit-approver', ['finance.credit_approve']);
        $credit = app(MaintainFinancialCredit::class)->propose(
            $creditProposer,
            $this->studentId,
            '25.00',
            'verified advance',
            'coverage-revoke-db-credit-source',
            'coverage-revoke-db-credit-propose',
        );
        app(MaintainFinancialCredit::class)->approve(
            $creditApprover,
            FinancialCredit::query()->findOrFail($credit['credit_id']),
            'coverage-revoke-db-credit-approve',
        );

        $this->expectException(QueryException::class);
        $this->expectExceptionMessage('born proposed');
        DB::table('financial_coverage_revocations')->insert([
            'id' => RandomIdentifier::new(),
            'coverage_source_type' => FinancialCoverageCommitment::SOURCE_FINANCIAL_CREDIT,
            'coverage_source_id' => $credit['credit_id'],
            'student_id' => $this->studentId,
            'reason' => 'attempted raw bypass',
            'lifecycle_state' => FinancialCoverageRevocation::STATE_RECORDED,
            'requested_by' => RandomIdentifier::new(),
            'approved_by' => RandomIdentifier::new(),
            'approved_at' => now(),
            'created_at' => now(),
            'updated_at' => now(),
        ]);
    }

    public function test_database_rejects_approval_without_exact_attributed_commitments(): void
    {
        $proposer = $this->grantedActor('coverage-raw-proposer', ['finance.credit']);
        $approver = $this->grantedActor('coverage-raw-approver', ['finance.credit_approve']);
        $proposed = app(MaintainFinancialCredit::class)->propose(
            $proposer,
            $this->studentId,
            '50.00',
            'verified advance',
            'coverage-raw-source',
            'coverage-raw-propose',
        );

        $this->expectException(QueryException::class);
        $this->expectExceptionMessage('requires exact immutable obligation commitments');
        DB::table('financial_credits')->where('id', $proposed['credit_id'])->update([
            'lifecycle_state' => FinancialCredit::STATE_APPROVED,
            'approved_by' => $approver->actorId,
            'approved_at' => now(),
            'updated_at' => now(),
        ]);
    }

    public function test_database_rejects_mutating_coverage_commitments(): void
    {
        $proposer = $this->grantedActor('coverage-immutable-proposer', ['finance.credit']);
        $approver = $this->grantedActor('coverage-immutable-approver', ['finance.credit_approve']);
        $proposed = app(MaintainFinancialCredit::class)->propose(
            $proposer,
            $this->studentId,
            '50.00',
            'verified advance',
            'coverage-immutable-source',
            'coverage-immutable-propose',
        );
        app(MaintainFinancialCredit::class)->approve(
            $approver,
            FinancialCredit::query()->findOrFail($proposed['credit_id']),
            'coverage-immutable-approve',
        );
        $commitmentId = (string) FinancialCoverageCommitment::query()
            ->where('coverage_source_id', $proposed['credit_id'])
            ->value('id');

        $this->expectException(QueryException::class);
        DB::table('financial_coverage_commitments')->where('id', $commitmentId)->update(['amount' => '1.00']);
    }
}
