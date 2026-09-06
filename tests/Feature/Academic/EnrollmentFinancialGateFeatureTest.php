<?php

declare(strict_types=1);

namespace Tests\Feature\Academic;

use App\Modules\Academic\Commands\MaintainAcademicStructure;
use App\Modules\Academic\Commands\MaintainClass;
use App\Modules\Academic\Commands\MaintainEnrollment;
use App\Modules\Academic\Models\AcademicPeriod;
use App\Modules\Academic\Models\ClassModel;
use App\Modules\Academic\Models\Enrollment;
use App\Modules\Academic\Models\Program;
use App\Modules\Finance\Commands\AllocateFunds;
use App\Modules\Finance\Commands\AllocatePayment;
use App\Modules\Finance\Commands\MaintainDiscount;
use App\Modules\Finance\Commands\MaintainFinancialCredit;
use App\Modules\Finance\Commands\MaintainFinancialGateException;
use App\Modules\Finance\Commands\MaintainInstallmentPlan;
use App\Modules\Finance\Commands\PostObligation;
use App\Modules\Finance\Commands\RecordPayment;
use App\Modules\Finance\Domain\FinancialGateEvidence;
use App\Modules\Finance\Models\Discount;
use App\Modules\Finance\Models\EnrollmentInstallmentPlan;
use App\Modules\Finance\Models\FinancialCredit;
use App\Modules\Finance\Models\FinancialGateException;
use App\Modules\Finance\Models\FinancialPeriod;
use App\Modules\Finance\Models\FundingSource;
use App\Modules\Finance\Models\Obligation;
use App\Modules\Finance\Models\ObligationLine;
use App\Modules\Finance\Models\Payment;
use App\Support\Errors\DomainError;
use App\Support\Identifiers\RandomIdentifier;
use Carbon\CarbonImmutable;
use Illuminate\Database\QueryException;
use Tests\Concerns\BuildsStudents;
use Tests\TestCase;

/**
 * AC3 financial gate: Academic activation is allowed only when the
 * Finance-authoritative assessment is satisfied — payment, waiver/discount,
 * sponsorship/funding, credit, installment, or approved exception. Academic
 * never re-derives the balance; it freezes signed evidence and records a
 * denied gate when the gate is unsatisfied.
 */
final class EnrollmentFinancialGateFeatureTest extends TestCase
{
    use BuildsStudents;

    /** @return array{class_id: string, student_id: string, enrollment_id: string, period_id: string, program_version_id: string, level_id: string} */
    private function makeEnrollmentRequest(string $seed): array
    {
        $officer = $this->academicOfficer('gate-officer-'.$seed);
        $structure = app(MaintainAcademicStructure::class);
        $this->personWithAuthority('gate-teacher-'.$seed, []);

        $program = $structure->defineProgram($officer, 'Gate Program '.$seed, 'gate-prog-'.$seed);
        $version = $structure->publishVersion($officer, Program::query()->findOrFail($program['program_id']), 'Gate v1', 'gate-ver-'.$seed);
        $programVersionId = (string) $version['version_id'];
        $levelId = (string) $structure->defineLevel($officer, $programVersionId, 'gate level', 1, 'Gate Level', 'B1', 'gate-lvl-'.$seed)['level_id'];
        $periodId = (string) $structure->definePeriod($officer, 'Gate Term '.$seed, new CarbonImmutable('2026-09-01'), new CarbonImmutable('2026-12-31'), 'gate-period-'.$seed)['period_id'];
        $structure->transitionPeriod($officer, AcademicPeriod::query()->findOrFail($periodId), 'published', 'gate-period-pub-'.$seed);

        $classId = (string) app(MaintainClass::class)->defineClass(
            $officer,
            $programVersionId,
            $periodId,
            5,
            'Gate Class '.$seed,
            $levelId,
        )['class_id'];
        app(MaintainClass::class)->assignTeacher($officer, ClassModel::query()->findOrFail($classId), 'gate-teacher-'.$seed, new CarbonImmutable('2026-09-01'), null, 'gate-class-teacher-'.$seed);
        app(MaintainClass::class)->transition($officer, ClassModel::query()->findOrFail($classId), 'published', 'gate-class-pub-'.$seed);
        app(MaintainClass::class)->transition($officer, ClassModel::query()->findOrFail($classId), 'active', 'gate-class-active-'.$seed);

        $studentId = (string) $this->makeStudent([
            'initiator' => 'gate-adm-init-'.$seed,
            'reviewer' => 'gate-adm-review-'.$seed,
            'approver' => 'gate-adm-approve-'.$seed,
        ])['student']->id;

        $clerk = $this->enrollmentClerk('gate-clerk-'.$seed);
        $seat = app(MaintainEnrollment::class)->request($clerk, $studentId, $classId, 'gate-enroll-'.$seed);

        return [
            'class_id' => $classId,
            'student_id' => $studentId,
            'enrollment_id' => $seat['enrollment_id'],
            'period_id' => $periodId,
            'program_version_id' => $programVersionId,
            'level_id' => $levelId,
        ];
    }

    private function openPeriod(string $seed): FinancialPeriod
    {
        return FinancialPeriod::query()->create([
            'id' => RandomIdentifier::new(),
            'period_key' => 'gate-'.$seed.'-'.substr(md5(RandomIdentifier::new()), 0, 8),
            'date_from' => '2026-09-01',
            'date_to' => '2026-12-31',
            'lifecycle_state' => 'open',
        ]);
    }

    private function postTuitionObligation(string $seed, FinancialPeriod $period, string $studentId): Obligation
    {
        $poster = $this->grantedActor('gate-obligation-'.$seed, ['finance.obligation']);
        $post = app(PostObligation::class)->post($poster, $period, $studentId, 'admissions/tuition', 'Gate tuition', [
            ['category' => 'tuition', 'amount' => '1000.00', 'source_ref' => 'gate-tuition-'.$seed],
        ], 'gate-obligation-'.$seed);

        return Obligation::query()->findOrFail($post['obligation_id']);
    }

    public function test_unpaid_obligation_denies_activation_and_freezes_signed_evidence(): void
    {
        $setup = $this->makeEnrollmentRequest('deny');
        $period = $this->openPeriod('deny');
        $this->postTuitionObligation('deny', $period, $setup['student_id']);

        try {
            app(MaintainEnrollment::class)->activate(
                $this->academicOfficer('gate-activate-deny'),
                Enrollment::query()->findOrFail($setup['enrollment_id']),
                'gate-activate-deny',
            );
            $this->fail('an unpaid obligation must refuse activation');
        } catch (DomainError $rejection) {
            $this->assertSame('academic.enrollment.financial_gate', $rejection->errorCode());
        }

        $enrollment = Enrollment::query()->findOrFail($setup['enrollment_id']);
        $this->assertSame('requested', $enrollment->lifecycle_state);
        $this->assertFalse((bool) $enrollment->financial_gate_satisfied);
        $this->assertNotNull($enrollment->financial_gate_evidence_sha256);
        $this->assertNotNull($enrollment->financial_gate_signature);
        $this->assertSame('1000.00', $enrollment->financial_gate_evidence['uncovered']);
        $this->assertSame('0.00', $enrollment->financial_gate_evidence['coverage']['payment_discount_funding']);
        $this->assertSame('1000.00', $enrollment->financial_gate_evidence['remaining']);

        $this->assertDatabaseHas('audit_events', [
            'operation' => 'academic.enrollment.financial_gate.denied',
            'target_type' => 'enrollment',
            'target_id' => $setup['enrollment_id'],
        ]);
    }

    public function test_payment_settlement_satisfies_gate(): void
    {
        $setup = $this->makeEnrollmentRequest('pay');
        $period = $this->openPeriod('pay');
        $obligation = $this->postTuitionObligation('pay', $period, $setup['student_id']);

        $financier = $this->grantedActor('gate-pay-financier', ['finance.payment']);
        $recorded = app(RecordPayment::class)->record($financier, $period, $setup['student_id'], '1000.00', 'bank', 'gate-payer-'.$setup['student_id'], '2026-09-02', 'gate-payment-'.$setup['student_id']);
        app(AllocatePayment::class)->allocate($financier, Payment::query()->findOrFail($recorded['payment_id']), $obligation, '1000.00', 'gate-allocation-'.$setup['student_id']);

        $activation = app(MaintainEnrollment::class)->activate(
            $this->academicOfficer('gate-activate-pay'),
            Enrollment::query()->findOrFail($setup['enrollment_id']),
            'gate-activate-pay',
        );
        $this->assertSame('active', $activation['lifecycle_state']);

        $enrollment = Enrollment::query()->findOrFail($setup['enrollment_id']);
        $this->assertTrue((bool) $enrollment->financial_gate_satisfied);
        $this->assertSame('0.00', $enrollment->financial_gate_evidence['remaining']);
        $this->assertSame('1000.00', $enrollment->financial_gate_evidence['coverage']['payment_discount_funding']);
    }

    public function test_approved_discount_satisfies_gate(): void
    {
        $setup = $this->makeEnrollmentRequest('waiver');
        $period = $this->openPeriod('waiver');
        $obligation = $this->postTuitionObligation('waiver', $period, $setup['student_id']);

        $proposer = $this->grantedActor('gate-waiver-proposer', ['finance.discount']);
        $approver = $this->grantedActor('gate-waiver-approver', ['finance.discount_approve']);
        $proposed = app(MaintainDiscount::class)->propose($proposer, $obligation, $period, '1000.00', 'need-based scholarship', '2026-09-01', null, 'full need-based award', 'gate-waiver-propose');
        app(MaintainDiscount::class)->approve($approver, Discount::query()->findOrFail($proposed['discount_id']), 'gate-waiver-approve');

        $activation = app(MaintainEnrollment::class)->activate(
            $this->academicOfficer('gate-activate-waiver'),
            Enrollment::query()->findOrFail($setup['enrollment_id']),
            'gate-activate-waiver',
        );
        $this->assertSame('active', $activation['lifecycle_state']);
        $this->assertSame('0.00', Enrollment::query()->findOrFail($setup['enrollment_id'])->financial_gate_evidence['remaining']);
    }

    public function test_funding_allocation_satisfies_gate(): void
    {
        $setup = $this->makeEnrollmentRequest('sponsor');
        $period = $this->openPeriod('sponsor');
        $obligation = $this->postTuitionObligation('sponsor', $period, $setup['student_id']);

        $fundManager = $this->grantedActor('gate-sponsor-manager', ['finance.fund', 'finance.fund_allocate']);
        $established = app(AllocateFunds::class)->establish($fundManager, 'Sponsorship Pool', 'gate-sponsor-agreement', '1000.00', 'tuition', 'sponsorship', 'gate-fund-establish');
        $line = ObligationLine::query()->where('obligation_id', $obligation->id)->firstOrFail();
        app(AllocateFunds::class)->allocate($fundManager, FundingSource::query()->findOrFail($established['fund_id']), $line, '1000.00', 'sponsorship settlement', 'gate-fund-allocate');

        $activation = app(MaintainEnrollment::class)->activate(
            $this->academicOfficer('gate-activate-sponsor'),
            Enrollment::query()->findOrFail($setup['enrollment_id']),
            'gate-activate-sponsor',
        );
        $this->assertSame('active', $activation['lifecycle_state']);
        $this->assertSame('0.00', Enrollment::query()->findOrFail($setup['enrollment_id'])->financial_gate_evidence['remaining']);
    }

    public function test_approved_credit_satisfies_gate(): void
    {
        $setup = $this->makeEnrollmentRequest('credit');
        $period = $this->openPeriod('credit');
        $this->postTuitionObligation('credit', $period, $setup['student_id']);

        $proposer = $this->grantedActor('gate-credit-proposer', ['finance.credit']);
        $approver = $this->grantedActor('gate-credit-approver', ['finance.credit_approve']);
        $proposed = app(MaintainFinancialCredit::class)->propose($proposer, $setup['student_id'], '1000.00', 'approved credit advance', 'gate-credit-src', 'gate-credit-propose');
        app(MaintainFinancialCredit::class)->approve($approver, FinancialCredit::query()->findOrFail($proposed['credit_id']), 'gate-credit-approve');

        $activation = app(MaintainEnrollment::class)->activate(
            $this->academicOfficer('gate-activate-credit'),
            Enrollment::query()->findOrFail($setup['enrollment_id']),
            'gate-activate-credit',
        );
        $this->assertSame('active', $activation['lifecycle_state']);
        $proof = Enrollment::query()->findOrFail($setup['enrollment_id'])->financial_gate_evidence;
        $this->assertSame('0.00', $proof['remaining']);
        $this->assertSame('1000.00', $proof['coverage']['credit']);
    }

    public function test_approved_installment_satisfies_gate(): void
    {
        $setup = $this->makeEnrollmentRequest('installment');
        $period = $this->openPeriod('installment');
        $this->postTuitionObligation('installment', $period, $setup['student_id']);

        $proposer = $this->grantedActor('gate-installment-proposer', ['finance.installment']);
        $approver = $this->grantedActor('gate-installment-approver', ['finance.installment_approve']);
        $proposed = app(MaintainInstallmentPlan::class)->propose($proposer, $setup['student_id'], null, '1000.00', 2, '2026-09-15', 'gate-installment-schedule', 'gate-installment-propose');
        app(MaintainInstallmentPlan::class)->approve($approver, EnrollmentInstallmentPlan::query()->findOrFail($proposed['plan_id']), 'gate-installment-approve');

        $activation = app(MaintainEnrollment::class)->activate(
            $this->academicOfficer('gate-activate-installment'),
            Enrollment::query()->findOrFail($setup['enrollment_id']),
            'gate-activate-installment',
        );
        $this->assertSame('active', $activation['lifecycle_state']);
        $proof = Enrollment::query()->findOrFail($setup['enrollment_id'])->financial_gate_evidence;
        $this->assertSame('0.00', $proof['remaining']);
        $this->assertSame('1000.00', $proof['coverage']['installment']);
    }

    public function test_approved_exception_satisfies_gate(): void
    {
        $setup = $this->makeEnrollmentRequest('exception');
        $period = $this->openPeriod('exception');
        $this->postTuitionObligation('exception', $period, $setup['student_id']);

        $proposer = $this->grantedActor('gate-exception-proposer', ['finance.gate_exception']);
        $approver = $this->grantedActor('gate-exception-approver', ['finance.gate_exception_approve']);
        $proposed = app(MaintainFinancialGateException::class)->propose($proposer, $setup['student_id'], null, null, '1000.00', 'approved alternative settlement', '2026-09-01', null, 'gate-exception-propose');
        app(MaintainFinancialGateException::class)->approve($approver, FinancialGateException::query()->findOrFail($proposed['exception_id']), 'gate-exception-approve');

        $activation = app(MaintainEnrollment::class)->activate(
            $this->academicOfficer('gate-activate-exception'),
            Enrollment::query()->findOrFail($setup['enrollment_id']),
            'gate-activate-exception',
        );
        $this->assertSame('active', $activation['lifecycle_state']);
        $proof = Enrollment::query()->findOrFail($setup['enrollment_id'])->financial_gate_evidence;
        $this->assertSame('0.00', $proof['remaining']);
        $this->assertSame('1000.00', $proof['coverage']['exception']);
    }

    public function test_finance_approval_requires_separation_of_duties_for_credit_installment_and_exception(): void
    {
        $setup = $this->makeEnrollmentRequest('sod');
        $period = $this->openPeriod('sod');
        $this->postTuitionObligation('sod', $period, $setup['student_id']);

        $sameActor = $this->grantedActor('gate-sod-credit', ['finance.credit', 'finance.credit_approve', 'finance.installment', 'finance.installment_approve', 'finance.gate_exception', 'finance.gate_exception_approve']);

        $credit = app(MaintainFinancialCredit::class)->propose($sameActor, $setup['student_id'], '1000.00', 'credit', 'gate-sod-credit-src', 'gate-sod-credit-propose');
        try {
            app(MaintainFinancialCredit::class)->approve($sameActor, FinancialCredit::query()->findOrFail($credit['credit_id']), 'gate-sod-credit-approve');
            $this->fail('the same actor cannot approve a credit they proposed');
        } catch (DomainError $rejection) {
            $this->assertSame('finance.credit_not_independent', $rejection->errorCode());
        }

        $installment = app(MaintainInstallmentPlan::class)->propose($sameActor, $setup['student_id'], null, '1000.00', 2, '2026-09-15', 'gate-sod-installment', 'gate-sod-installment-propose');
        try {
            app(MaintainInstallmentPlan::class)->approve($sameActor, EnrollmentInstallmentPlan::query()->findOrFail($installment['plan_id']), 'gate-sod-installment-approve');
            $this->fail('the same actor cannot approve an installment they proposed');
        } catch (DomainError $rejection) {
            $this->assertSame('finance.installment_not_independent', $rejection->errorCode());
        }

        $exception = app(MaintainFinancialGateException::class)->propose($sameActor, $setup['student_id'], null, null, '1000.00', 'exception', '2026-09-01', null, 'gate-sod-exception-propose');
        try {
            app(MaintainFinancialGateException::class)->approve($sameActor, FinancialGateException::query()->findOrFail($exception['exception_id']), 'gate-sod-exception-approve');
            $this->fail('the same actor cannot approve an exception they proposed');
        } catch (DomainError $rejection) {
            $this->assertSame('finance.gate_exception_not_independent', $rejection->errorCode());
        }
    }

    public function test_approved_finance_facts_are_immutable_at_the_database(): void
    {
        $setup = $this->makeEnrollmentRequest('immutable');
        $period = $this->openPeriod('immutable');
        $this->postTuitionObligation('immutable', $period, $setup['student_id']);

        $proposer = $this->grantedActor('gate-immutable-credit-proposer', ['finance.credit', 'finance.installment', 'finance.gate_exception']);
        $approver = $this->grantedActor('gate-immutable-credit-approver', ['finance.credit_approve', 'finance.installment_approve', 'finance.gate_exception_approve']);

        $credit = app(MaintainFinancialCredit::class)->propose($proposer, $setup['student_id'], '1000.00', 'credit', 'gate-immutable-credit-src', 'gate-immutable-credit-propose');
        app(MaintainFinancialCredit::class)->approve($approver, FinancialCredit::query()->findOrFail($credit['credit_id']), 'gate-immutable-credit-approve');
        $creditModel = FinancialCredit::query()->findOrFail($credit['credit_id']);
        try {
            $creditModel->forceFill(['amount' => '2000.00'])->save();
            $this->fail('an approved credit cannot be mutated');
        } catch (QueryException) {
        }
        $this->assertSame('1000.00', trim((string) $creditModel->fresh()->amount));

        $installment = app(MaintainInstallmentPlan::class)->propose($proposer, $setup['student_id'], null, '1000.00', 2, '2026-09-15', 'gate-immutable-installment', 'gate-immutable-installment-propose');
        app(MaintainInstallmentPlan::class)->approve($approver, EnrollmentInstallmentPlan::query()->findOrFail($installment['plan_id']), 'gate-immutable-installment-approve');
        $planModel = EnrollmentInstallmentPlan::query()->findOrFail($installment['plan_id']);
        try {
            $planModel->forceFill(['installments_count' => 9])->save();
            $this->fail('an approved installment plan cannot be mutated');
        } catch (QueryException) {
        }
        $this->assertSame(2, (int) $planModel->fresh()->installments_count);

        $exception = app(MaintainFinancialGateException::class)->propose($proposer, $setup['student_id'], null, null, '1000.00', 'exception', '2026-09-01', null, 'gate-immutable-exception-propose');
        app(MaintainFinancialGateException::class)->approve($approver, FinancialGateException::query()->findOrFail($exception['exception_id']), 'gate-immutable-exception-approve');
        $exceptionModel = FinancialGateException::query()->findOrFail($exception['exception_id']);
        try {
            $exceptionModel->forceFill(['reason' => 'changed'])->save();
            $this->fail('an approved gate exception cannot be mutated');
        } catch (QueryException) {
        }
        $this->assertSame('exception', trim((string) $exceptionModel->fresh()->reason));
    }

    public function test_signed_evidence_rejects_tampering(): void
    {
        $setup = $this->makeEnrollmentRequest('tamper');
        $period = $this->openPeriod('tamper');
        $this->postTuitionObligation('tamper', $period, $setup['student_id']);

        $proposer = $this->grantedActor('gate-tamper-credit-proposer', ['finance.credit']);
        $approver = $this->grantedActor('gate-tamper-credit-approver', ['finance.credit_approve']);
        $proposed = app(MaintainFinancialCredit::class)->propose($proposer, $setup['student_id'], '1000.00', 'credit', 'gate-tamper-src', 'gate-tamper-propose');
        app(MaintainFinancialCredit::class)->approve($approver, FinancialCredit::query()->findOrFail($proposed['credit_id']), 'gate-tamper-approve');

        app(MaintainEnrollment::class)->activate(
            $this->academicOfficer('gate-activate-tamper'),
            Enrollment::query()->findOrFail($setup['enrollment_id']),
            'gate-activate-tamper',
        );
        $enrollment = Enrollment::query()->findOrFail($setup['enrollment_id']);
        $tampered = $enrollment->financial_gate_evidence;
        $tampered['remaining'] = '9999.99';

        $this->assertFalse(FinancialGateEvidence::verify($tampered, (string) $enrollment->financial_gate_evidence_sha256, (string) $enrollment->financial_gate_signature));
    }

    public function test_finance_fact_proposals_are_idempotent(): void
    {
        $setup = $this->makeEnrollmentRequest('idem');
        $period = $this->openPeriod('idem');
        $this->postTuitionObligation('idem', $period, $setup['student_id']);

        $proposer = $this->grantedActor('gate-idem-credit-proposer', ['finance.credit', 'finance.installment', 'finance.gate_exception']);

        $firstCredit = app(MaintainFinancialCredit::class)->propose($proposer, $setup['student_id'], '1000.00', 'credit', 'gate-idem-credit-src', 'gate-idem-key');
        $repeatedCredit = app(MaintainFinancialCredit::class)->propose($proposer, $setup['student_id'], '1000.00', 'credit', 'gate-idem-credit-src', 'gate-idem-key');
        $this->assertSame($firstCredit['credit_id'], $repeatedCredit['credit_id']);
        $this->assertSame(1, FinancialCredit::query()->where('source_ref', 'gate-idem-credit-src')->count());

        $firstInstallment = app(MaintainInstallmentPlan::class)->propose($proposer, $setup['student_id'], null, '1000.00', 2, '2026-09-15', 'gate-idem-installment', 'gate-idem-installment-key');
        $repeatedInstallment = app(MaintainInstallmentPlan::class)->propose($proposer, $setup['student_id'], null, '1000.00', 2, '2026-09-15', 'gate-idem-installment', 'gate-idem-installment-key');
        $this->assertSame($firstInstallment['plan_id'], $repeatedInstallment['plan_id']);

        $firstException = app(MaintainFinancialGateException::class)->propose($proposer, $setup['student_id'], null, null, '1000.00', 'exception', '2026-09-01', null, 'gate-idem-exception-key');
        $repeatedException = app(MaintainFinancialGateException::class)->propose($proposer, $setup['student_id'], null, null, '1000.00', 'exception', '2026-09-01', null, 'gate-idem-exception-key');
        $this->assertSame($firstException['exception_id'], $repeatedException['exception_id']);
    }
}
