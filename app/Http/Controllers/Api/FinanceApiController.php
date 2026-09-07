<?php

declare(strict_types=1);

namespace App\Http\Controllers\Api;

use App\Http\Controllers\Controller;
use App\Modules\Finance\Commands\AllocateFunds;
use App\Modules\Finance\Commands\AllocatePayment;
use App\Modules\Finance\Commands\MaintainChartOfAccounts;
use App\Modules\Finance\Commands\MaintainDiscount;
use App\Modules\Finance\Commands\MaintainEmploymentSettlement;
use App\Modules\Finance\Commands\MaintainFinancialCorrection;
use App\Modules\Finance\Commands\MaintainFinancialCredit;
use App\Modules\Finance\Commands\MaintainFinancialGateException;
use App\Modules\Finance\Commands\MaintainFinancialPeriod;
use App\Modules\Finance\Commands\MaintainInstallmentPlan;
use App\Modules\Finance\Commands\PostJournal;
use App\Modules\Finance\Commands\PostObligation;
use App\Modules\Finance\Commands\RecognizePayrollLiability;
use App\Modules\Finance\Commands\RecordPayment;
use App\Modules\Finance\Commands\RecordReconciliation;
use App\Modules\Finance\Commands\RefundPayment;
use App\Modules\Finance\Commands\RevokeFinancialCoverage;
use App\Modules\Finance\Models\FinancialCorrection;
use App\Modules\Finance\Models\Account;
use App\Modules\Finance\Models\Discount;
use App\Modules\Finance\Models\EnrollmentInstallmentPlan;
use App\Modules\Finance\Models\FinancialCredit;
use App\Modules\Finance\Models\FinancialCoverageRevocation;
use App\Modules\Finance\Models\FinancialGateException;
use App\Modules\Finance\Models\FinancialPeriod;
use App\Modules\Finance\Models\FundAllocation;
use App\Modules\Finance\Models\FundingSource;
use App\Modules\Finance\Models\Journal;
use App\Modules\Finance\Models\Obligation;
use App\Modules\Finance\Models\Payment;
use App\Modules\Finance\Models\PaymentAllocation;
use App\Modules\Finance\Models\Reconciliation;
use App\Modules\Finance\Models\Refund;
use App\Modules\Hr\Models\Employment;
use App\Modules\Identity\Models\Person;
use App\Modules\Payroll\Models\SettlementProposal;
use Illuminate\Http\JsonResponse;
use Illuminate\Http\Request;

/** JSON interface for the money surface (delegates to the same commands). */
final class FinanceApiController extends Controller
{
    public function obligations(): JsonResponse
    {
        $visible = $this->authorizedBranches('finance.obligation');
        $obligations = Obligation::query()
            ->where(function ($query) use ($visible): void {
                $query->whereIn('current_home_branch_id', $visible)
                    ->orWhere(function ($query) use ($visible): void {
                        $query->whereNull('current_home_branch_id')->whereIn('originating_branch_id', $visible);
                    });
            })
            ->orderByDesc('id')->limit(200)->get();

        return response()->json(['obligations' => $obligations]);
    }

    public function payments(): JsonResponse
    {
        $visible = $this->authorizedBranches('finance.payment');
        $payments = Payment::query()
            ->where(function ($query) use ($visible): void {
                $query->whereIn('current_home_branch_id', $visible)
                    ->orWhere(function ($query) use ($visible): void {
                        $query->whereNull('current_home_branch_id')->whereIn('originating_branch_id', $visible);
                    });
            })
            ->orderByDesc('received_on')->limit(200)->get();

        return response()->json(['payments' => $payments]);
    }

    public function approveEmploymentSettlement(string $proposalId): JsonResponse
    {
        $employmentIds = Employment::query()
            ->whereIn('person_id', Person::query()->whereIn('home_branch_id', $this->authorizedBranches('finance.employment_settlement'))->select('id'))
            ->select('id');
        $proposal = SettlementProposal::query()->whereKey($proposalId)->whereIn('employment_id', $employmentIds)->firstOrFail();
        $employment = Employment::query()->whereIn('id', $employmentIds)->findOrFail($proposal->employment_id);
        $result = app(MaintainEmploymentSettlement::class)->record(
            $this->actor(),
            $employment,
            (string) $proposal->id,
            (string) $proposal->amount,
            (string) $proposal->basis,
            (string) $proposal->prepared_by,
            $this->idempotencyKey('finance.employment-settlement.record'),
        );

        return response()->json(['status' => 'recorded', ...$result]);
    }

    public function recognizePayrollLiability(Request $request): JsonResponse
    {
        $input = $request->validate([
            'source_type' => ['required', 'in:payroll_result,payroll_adjustment'],
            'source_id' => ['required', 'string'],
            'amount' => ['required', 'numeric', 'signed_money'],
            'evidence_ref' => ['required', 'string', 'max:255'],
        ]);
        $result = app(RecognizePayrollLiability::class)->recognize(
            $this->actor(), $input['source_type'], $input['source_id'], $input['amount'], $input['evidence_ref'],
            $this->idempotencyKey('finance.payroll-liability.recognize'),
        );

        return response()->json(['status' => 'recognized', ...$result], 201);
    }

    public function record(Request $request): JsonResponse
    {
        $input = $request->validate([
            'period_id' => ['required', 'string'],
            'student_id' => ['required', 'string'],
            'amount' => ['required', 'numeric', 'money', 'gt:0'],
            'method' => ['required', 'string', 'max:40'],
            'payer_ref' => ['required', 'string', 'max:120'],
            'received_on' => ['required', 'date'],
        ]);

        app(RecordPayment::class)->record(
            $this->actor(),
            FinancialPeriod::query()->findOrFail((string) $input['period_id']),
            $input['student_id'],
            $input['amount'],
            $input['method'],
            $input['payer_ref'],
            $input['received_on'],
            $this->idempotencyKey('finance.payment'),
        );

        return response()->json(['status' => 'recorded'], 201);
    }

    public function postObligation(Request $request): JsonResponse
    {
        $input = $request->validate([
            'period_id' => ['required', 'string'], 'student_id' => ['required', 'string'],
            'source' => ['required', 'string', 'max:120'], 'reason' => ['required', 'string', 'max:1000'],
            'category' => ['required', 'string', 'max:120'], 'amount' => ['required', 'numeric', 'money', 'gt:0'],
            'source_ref' => ['required', 'string', 'max:120'], 'offering_id' => ['nullable', 'string'],
        ]);
        $result = app(PostObligation::class)->post(
            $this->actor(), FinancialPeriod::query()->findOrFail((string) $input['period_id']), $input['student_id'],
            $input['source'], $input['reason'], [[
                'category' => $input['category'], 'amount' => $input['amount'], 'source_ref' => $input['source_ref'],
            ]], $this->idempotencyKey('finance.obligation.post'), $input['offering_id'] ?? null,
        );

        return response()->json(['status' => 'posted', ...$result], 201);
    }

    public function allocatePayment(Request $request, string $obligationId): JsonResponse
    {
        $input = $request->validate([
            'payment_id' => ['required', 'string'], 'amount' => ['required', 'numeric', 'money', 'gt:0'],
        ]);
        $result = app(AllocatePayment::class)->allocate(
            $this->actor(), Payment::query()->findOrFail((string) $input['payment_id']),
            Obligation::query()->findOrFail($obligationId), $input['amount'],
            $this->idempotencyKey('finance.allocate'),
        );

        return response()->json(['status' => 'allocated', ...$result], 201);
    }

    public function openPeriod(Request $request): JsonResponse
    {
        $input = $request->validate([
            'period_key' => ['required', 'string', 'max:40'], 'date_from' => ['required', 'date'],
            'date_to' => ['required', 'date', 'after_or_equal:date_from'],
        ]);
        $result = app(MaintainFinancialPeriod::class)->open(
            $this->actor(), $input['period_key'], $input['date_from'], $input['date_to'],
            $this->idempotencyKey('finance.period.open'),
        );

        return response()->json(['status' => 'opened', ...$result], 201);
    }

    public function closePeriod(string $periodId): JsonResponse
    {
        $result = app(MaintainFinancialPeriod::class)->close(
            $this->actor(), FinancialPeriod::query()->findOrFail($periodId),
            $this->idempotencyKey('finance.period.close'),
        );

        return response()->json(['status' => 'closed', ...$result]);
    }

    public function defineAccount(Request $request): JsonResponse
    {
        $input = $request->validate([
            'code' => ['required', 'string', 'max:40'], 'name' => ['required', 'string', 'max:120'],
            'type' => ['required', 'in:asset,liability,equity,revenue,expense'],
        ]);
        $result = app(MaintainChartOfAccounts::class)->define(
            $this->actor(), $input['code'], $input['name'], $input['type'],
            $this->idempotencyKey('finance.account.define'),
        );

        return response()->json(['status' => 'defined', ...$result], 201);
    }

    public function postJournal(Request $request): JsonResponse
    {
        $input = $request->validate([
            'period_id' => ['required', 'string'], 'source_type' => ['required', 'in:obligation,payroll_liability,other'],
            'source_id' => ['nullable', 'string'], 'reason' => ['required', 'string', 'max:1000'],
            'lines' => ['required', 'array', 'min:1'], 'lines.*.account_id' => ['required', 'string'],
            'lines.*.direction' => ['required', 'in:debit,credit'], 'lines.*.amount' => ['required', 'numeric', 'money', 'gt:0'],
        ]);
        $lines = array_values(array_map(static fn (array $line): array => [
            'account_id' => $line['account_id'], 'direction' => $line['direction'], 'amount' => (string) $line['amount'],
        ], $input['lines']));
        $result = app(PostJournal::class)->post(
            $this->actor(), FinancialPeriod::query()->findOrFail((string) $input['period_id']), $input['source_type'],
            $input['source_id'] ?? null, $input['reason'], $lines, $this->idempotencyKey('finance.journal.post'),
        );

        return response()->json(['status' => 'posted', ...$result], 201);
    }

    public function reverseJournal(Request $request, string $journalId): JsonResponse
    {
        $input = $request->validate(['reason' => ['required', 'string', 'max:1000']]);
        $result = app(PostJournal::class)->reverse(
            $this->actor(), Journal::query()->findOrFail($journalId), $input['reason'],
            $this->idempotencyKey('finance.journal.reverse'),
        );

        return response()->json(['status' => 'reversed', ...$result]);
    }

    public function proposeDiscount(Request $request): JsonResponse
    {
        $input = $request->validate([
            'obligation_id' => ['required', 'string'], 'period_id' => ['required', 'string'],
            'amount' => ['required', 'numeric', 'money', 'gt:0'], 'eligibility' => ['required', 'string', 'max:500'],
            'effective_from' => ['required', 'date'], 'effective_to' => ['nullable', 'date', 'after_or_equal:effective_from'],
            'reason' => ['required', 'string', 'max:1000'],
        ]);
        $result = app(MaintainDiscount::class)->propose(
            $this->actor(), Obligation::query()->findOrFail((string) $input['obligation_id']),
            FinancialPeriod::query()->findOrFail((string) $input['period_id']), $input['amount'], $input['eligibility'],
            $input['effective_from'], $input['effective_to'] ?? null, $input['reason'],
            $this->idempotencyKey('finance.discount.propose'),
        );

        return response()->json(['status' => 'proposed', ...$result], 201);
    }

    public function approveDiscount(string $discountId): JsonResponse
    {
        $result = app(MaintainDiscount::class)->approve(
            $this->actor(), Discount::query()->findOrFail($discountId),
            $this->idempotencyKey('finance.discount.approve'),
        );

        return response()->json(['status' => 'approved', ...$result]);
    }

    /**
     * The signed-in session PROPOSES the refund (requester). A different
     * session signed in as an approver records it via approve() — no
     * person-id may be supplied in the body.
     */
    public function proposeRefund(Request $request, string $paymentId): JsonResponse
    {
        $input = $request->validate([
            'period_id' => ['required', 'string'],
            'amount' => ['required', 'numeric', 'money', 'gt:0'],
            'reason' => ['required', 'string', 'max:1000'],
        ]);

        $result = app(RefundPayment::class)->propose(
            $this->actor(),
            Payment::query()->findOrFail($paymentId),
            FinancialPeriod::query()->findOrFail((string) $input['period_id']),
            $input['amount'],
            $input['reason'],
            $this->idempotencyKey('finance.refund.propose'),
        );

        return response()->json(['status' => 'proposed', 'refund_id' => $result['refund_id']], 201);
    }

    public function proposeObligationCorrection(Request $request, string $obligationId): JsonResponse
    {
        $input = $request->validate([
            'amount' => ['required', 'numeric', 'money', 'gt:0'],
            'direction' => ['required', 'in:decrease,increase'],
            'reason' => ['required', 'string', 'max:1000'],
        ]);
        $result = app(MaintainFinancialCorrection::class)->proposeObligationAdjustment(
            $this->actor(), Obligation::query()->findOrFail($obligationId), $input['amount'],
            $input['direction'], $input['reason'], $this->idempotencyKey('finance.correction.propose'),
        );

        return response()->json(['status' => 'proposed', ...$result], 201);
    }

    public function proposeAllocationReversal(Request $request, string $allocationId): JsonResponse
    {
        $input = $request->validate([
            'amount' => ['required', 'numeric', 'money', 'gt:0'],
            'reason' => ['required', 'string', 'max:1000'],
        ]);
        $result = app(MaintainFinancialCorrection::class)->proposeAllocationReversal(
            $this->actor(), PaymentAllocation::query()->findOrFail($allocationId), $input['amount'],
            $input['reason'], $this->idempotencyKey('finance.correction.propose'),
        );

        return response()->json(['status' => 'proposed', ...$result], 201);
    }

    public function approveFinancialCorrection(Request $request, string $correctionId): JsonResponse
    {
        $result = app(MaintainFinancialCorrection::class)->approve(
            $this->actor(), FinancialCorrection::query()->findOrFail($correctionId),
            $this->idempotencyKey('finance.correction.approve'),
        );

        return response()->json(['status' => 'recorded', ...$result]);
    }

    public function proposeFundAllocationReversal(Request $request, string $allocationId): JsonResponse
    {
        $input = $request->validate([
            'amount' => ['required', 'numeric', 'money', 'gt:0'],
            'reason' => ['required', 'string', 'max:1000'],
        ]);
        $result = app(MaintainFinancialCorrection::class)->proposeFundAllocationReversal(
            $this->actor(), FundAllocation::query()->findOrFail($allocationId), $input['amount'],
            $input['reason'], $this->idempotencyKey('finance.correction.propose'),
        );

        return response()->json(['status' => 'proposed', ...$result], 201);
    }

    public function observeReconciliation(Request $request): JsonResponse
    {
        $input = $request->validate([
            'period_id' => ['required', 'string'], 'subject' => ['required', 'string', 'max:120'],
            'expected' => ['required', 'numeric', 'money'], 'observed' => ['required', 'numeric', 'money'],
            'explanation' => ['nullable', 'string', 'max:1000'],
        ]);
        $result = app(RecordReconciliation::class)->observe(
            $this->actor(), FinancialPeriod::query()->findOrFail((string) $input['period_id']), $input['subject'],
            $input['expected'], $input['observed'], $input['explanation'] ?? null,
            $this->idempotencyKey('finance.reconciliation.observe'),
        );

        return response()->json(['status' => 'observed', ...$result], 201);
    }

    public function approveReconciliation(string $reconciliationId): JsonResponse
    {
        $result = app(RecordReconciliation::class)->approve(
            $this->actor(), Reconciliation::query()->findOrFail($reconciliationId),
            $this->idempotencyKey('finance.reconciliation.approve'),
        );

        return response()->json(['status' => 'approved', ...$result]);
    }

    public function establishFund(Request $request): JsonResponse
    {
        $input = $request->validate([
            'organization_id' => ['required', 'string'],
            'name' => ['required', 'string', 'max:120'], 'agreement_ref' => ['required', 'string', 'max:120'],
            'committed_amount' => ['required', 'numeric', 'money', 'gt:0'], 'restricted_category' => ['nullable', 'string', 'max:120'],
            'restriction_note' => ['nullable', 'string', 'max:1000'],
        ]);
        $result = app(AllocateFunds::class)->establish(
            $this->actor(), $input['organization_id'], $input['name'], $input['agreement_ref'], $input['committed_amount'],
            $input['restricted_category'] ?? null, $input['restriction_note'] ?? null,
            $this->idempotencyKey('finance.fund.establish'),
        );

        return response()->json(['status' => 'established', ...$result], 201);
    }

    public function allocateFund(Request $request, string $fundId): JsonResponse
    {
        $input = $request->validate([
            'obligation_line_id' => ['required', 'string'], 'amount' => ['required', 'numeric', 'money', 'gt:0'],
            'reason' => ['required', 'string', 'max:1000'],
        ]);
        $result = app(AllocateFunds::class)->allocate(
            $this->actor(), FundingSource::query()->findOrFail($fundId),
            \App\Modules\Finance\Models\ObligationLine::query()->findOrFail((string) $input['obligation_line_id']),
            $input['amount'], $input['reason'], $this->idempotencyKey('finance.fund.allocate'),
        );

        return response()->json(['status' => 'allocated', ...$result], 201);
    }

    public function proposeCredit(Request $request): JsonResponse
    {
        $input = $request->validate([
            'student_id' => ['required', 'string'], 'amount' => ['required', 'numeric', 'money', 'gt:0'],
            'reason' => ['required', 'string', 'max:1000'], 'source_ref' => ['required', 'string', 'max:120'],
        ]);
        $result = app(MaintainFinancialCredit::class)->propose(
            $this->actor(), $input['student_id'], $input['amount'], $input['reason'], $input['source_ref'],
            $this->idempotencyKey('finance.credit.propose'),
        );

        return response()->json(['status' => 'proposed', ...$result], 201);
    }

    public function approveCredit(string $creditId): JsonResponse
    {
        $result = app(MaintainFinancialCredit::class)->approve(
            $this->actor(), FinancialCredit::query()->findOrFail($creditId),
            $this->idempotencyKey('finance.credit.approve'),
        );

        return response()->json(['status' => 'approved', ...$result]);
    }

    public function proposeInstallment(Request $request): JsonResponse
    {
        $input = $request->validate([
            'student_id' => ['required', 'string'], 'offering_id' => ['nullable', 'string'],
            'amount' => ['required', 'numeric', 'money', 'gt:0'], 'installments_count' => ['required', 'integer', 'gt:0'],
            'first_due_on' => ['required', 'date'], 'schedule_ref' => ['required', 'string', 'max:120'],
        ]);
        $result = app(MaintainInstallmentPlan::class)->propose(
            $this->actor(), $input['student_id'], $input['offering_id'] ?? null, $input['amount'],
            (int) $input['installments_count'], $input['first_due_on'], $input['schedule_ref'],
            $this->idempotencyKey('finance.installment.propose'),
        );

        return response()->json(['status' => 'proposed', ...$result], 201);
    }

    public function approveInstallment(string $planId): JsonResponse
    {
        $result = app(MaintainInstallmentPlan::class)->approve(
            $this->actor(), EnrollmentInstallmentPlan::query()->findOrFail($planId),
            $this->idempotencyKey('finance.installment.approve'),
        );

        return response()->json(['status' => 'approved', ...$result]);
    }

    public function proposeGateException(Request $request): JsonResponse
    {
        $input = $request->validate([
            'student_id' => ['required', 'string'], 'offering_id' => ['nullable', 'string'], 'class_id' => ['nullable', 'string'],
            'amount' => ['required', 'numeric', 'money', 'gt:0'], 'reason' => ['required', 'string', 'max:1000'],
            'effective_from' => ['required', 'date'], 'effective_to' => ['nullable', 'date', 'after_or_equal:effective_from'],
        ]);
        $result = app(MaintainFinancialGateException::class)->propose(
            $this->actor(), $input['student_id'], $input['offering_id'] ?? null, $input['class_id'] ?? null,
            $input['amount'], $input['reason'], $input['effective_from'], $input['effective_to'] ?? null,
            $this->idempotencyKey('finance.gate_exception.propose'),
        );

        return response()->json(['status' => 'proposed', ...$result], 201);
    }

    public function approveGateException(string $exceptionId): JsonResponse
    {
        $result = app(MaintainFinancialGateException::class)->approve(
            $this->actor(), FinancialGateException::query()->findOrFail($exceptionId),
            $this->idempotencyKey('finance.gate_exception.approve'),
        );

        return response()->json(['status' => 'approved', ...$result]);
    }

    public function proposeCoverageRevocation(Request $request): JsonResponse
    {
        $input = $request->validate([
            'coverage_source_type' => ['required', 'in:financial_credit,enrollment_installment_plan,financial_gate_exception'],
            'coverage_source_id' => ['required', 'string', 'max:36'],
            'reason' => ['required', 'string', 'max:1000'],
        ]);
        $result = app(RevokeFinancialCoverage::class)->propose(
            $this->actor(),
            $input['coverage_source_type'],
            $input['coverage_source_id'],
            $input['reason'],
            $this->idempotencyKey('finance.coverage-revocation.propose'),
        );

        return response()->json(['status' => 'proposed', ...$result], 201);
    }

    public function approveCoverageRevocation(string $revocationId): JsonResponse
    {
        $result = app(RevokeFinancialCoverage::class)->approve(
            $this->actor(),
            FinancialCoverageRevocation::query()->findOrFail($revocationId),
            $this->idempotencyKey('finance.coverage-revocation.approve'),
        );

        return response()->json(['status' => 'recorded', ...$result]);
    }

    public function approveRefund(Request $request, string $refundId): JsonResponse
    {
        $result = app(RefundPayment::class)->approve(
            $this->actor(),
            Refund::query()->findOrFail($refundId),
            $this->idempotencyKey('finance.refund.approve'),
        );

        return response()->json(['status' => 'refunded', 'refund_id' => $result['refund_id']]);
    }
}
