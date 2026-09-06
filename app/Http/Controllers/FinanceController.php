<?php

declare(strict_types=1);

namespace App\Http\Controllers;

use App\Modules\Finance\Commands\AllocateFunds;
use App\Modules\Finance\Commands\AllocatePayment;
use App\Modules\Finance\Commands\MaintainChartOfAccounts;
use App\Modules\Finance\Commands\MaintainDiscount;
use App\Modules\Finance\Commands\MaintainFinancialCredit;
use App\Modules\Finance\Commands\MaintainFinancialGateException;
use App\Modules\Finance\Commands\MaintainFinancialPeriod;
use App\Modules\Finance\Commands\MaintainInstallmentPlan;
use App\Modules\Finance\Commands\PostJournal;
use App\Modules\Finance\Commands\PostObligation;
use App\Modules\Finance\Commands\RecordPayment;
use App\Modules\Finance\Commands\RecordReconciliation;
use App\Modules\Finance\Commands\RefundPayment;
use App\Modules\Finance\Models\Account;
use App\Modules\Finance\Models\Discount;
use App\Modules\Finance\Models\EnrollmentInstallmentPlan;
use App\Modules\Finance\Models\FinancialCredit;
use App\Modules\Finance\Models\FinancialGateException;
use App\Modules\Finance\Models\FinancialPeriod;
use App\Modules\Finance\Models\FundAllocation;
use App\Modules\Finance\Models\FundingSource;
use App\Modules\Finance\Models\Journal;
use App\Modules\Finance\Models\JournalLine;
use App\Modules\Finance\Models\Obligation;
use App\Modules\Finance\Models\ObligationLine;
use App\Modules\Finance\Models\Payment;
use App\Modules\Finance\Models\Reconciliation;
use App\Modules\Finance\Models\Refund;
use App\Modules\Students\Models\Student;
use Illuminate\Http\RedirectResponse;
use Illuminate\Http\Request;
use Illuminate\Validation\ValidationException;
use Illuminate\View\View;

/**
 * Finance console: the money surface (obligations, payments, refunds,
 * discounts, funding, periods). Every money movement delegates to the
 * finance module commands — balanced, source-linked, idempotent, and
 * reconciliation-ready. The console never computes financial truth itself.
 */
final class FinanceController extends Controller
{
    public function index(): View
    {
        return view('finance.index', [
            'obligations' => Obligation::query()->orderByDesc('id')->limit(200)->get(),
            'payments' => Payment::query()->orderByDesc('received_on')->limit(200)->get(),
            'refunds' => Refund::query()->where('lifecycle_state', 'recorded')->orderByDesc('id')->limit(200)->get(),
            'proposedRefunds' => Refund::query()->where('lifecycle_state', 'proposed')->orderByDesc('id')->limit(200)->get(),
            'discounts' => Discount::query()->orderByDesc('id')->limit(100)->get(),
            'credits' => FinancialCredit::query()->orderByDesc('id')->limit(100)->get(),
            'installmentPlans' => EnrollmentInstallmentPlan::query()->orderByDesc('id')->limit(100)->get(),
            'gateExceptions' => FinancialGateException::query()->orderByDesc('id')->limit(100)->get(),
            'fundingSources' => FundingSource::query()->orderBy('name')->get(),
            'fundAllocations' => FundAllocation::query()->orderByDesc('id')->limit(200)->get(),
            'periods' => FinancialPeriod::query()->orderBy('period_key')->get(),
            'students' => Student::query()->orderBy('student_code')->limit(300)->get(),
            'accounts' => Account::query()->orderBy('code')->get(),
            'journals' => Journal::query()->orderByDesc('id')->limit(100)->get(),
            'journalLines' => JournalLine::query()->orderByDesc('id')->limit(500)->get(),
            'reconciliations' => Reconciliation::query()->orderByDesc('id')->limit(100)->get(),
            'obligationLines' => ObligationLine::query()->orderByDesc('id')->limit(500)->get(),
        ]);
    }

    public function recordPayment(Request $request): RedirectResponse
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
            FinancialPeriod::query()->findOrFail($input['period_id']),
            $input['student_id'],
            $input['amount'],
            $input['method'],
            $input['payer_ref'],
            $input['received_on'],
            $this->idempotencyKey('finance.payment'),
        );

        return redirect()->route('finance.index')->with('success', 'Payment recorded.');
    }

    /**
     * The signed-in session PROPOSES the refund. A different session,
     * signed in as an approver holding finance.refund_approve, records it
     * via approveRefund() — the transport can no longer type a colleague's
     * person id into the form.
     */
    public function refund(Request $request, string $paymentId): RedirectResponse
    {
        $input = $request->validate([
            'period_id' => ['required', 'string'],
            'amount' => ['required', 'numeric', 'money', 'gt:0'],
            'reason' => ['required', 'string', 'max:1000'],
        ]);

        app(RefundPayment::class)->propose(
            $this->actor(),
            Payment::query()->findOrFail($paymentId),
            FinancialPeriod::query()->findOrFail($input['period_id']),
            $input['amount'],
            $input['reason'],
            $this->idempotencyKey('finance.refund.propose'),
        );

        return redirect()->route('finance.index')->with('success', 'Refund proposed; it takes effect once a distinct approver records it.');
    }

    public function approveRefund(Request $request, string $refundId): RedirectResponse
    {
        app(RefundPayment::class)->approve(
            $this->actor(),
            Refund::query()->findOrFail($refundId),
            $this->idempotencyKey('finance.refund.approve'),
        );

        return redirect()->route('finance.index')->with('success', 'Refund approved and recorded.');
    }

    public function allocate(Request $request, string $obligationId): RedirectResponse
    {
        $input = $request->validate([
            'payment_id' => ['required', 'string'],
            'amount' => ['required', 'numeric', 'money', 'gt:0'],
        ]);

        app(AllocatePayment::class)->allocate(
            $this->actor(),
            Payment::query()->findOrFail($input['payment_id']),
            Obligation::query()->findOrFail($obligationId),
            $input['amount'],
            $this->idempotencyKey('finance.allocate'),
        );

        return redirect()->route('finance.index')->with('success', 'Payment allocated to the obligation.');
    }

    public function postObligation(Request $request): RedirectResponse
    {
        $input = $request->validate([
            'period_id' => ['required', 'string'],
            'student_id' => ['required', 'string'],
            'source' => ['required', 'string', 'max:120'],
            'reason' => ['required', 'string', 'max:1000'],
            'category' => ['required', 'string', 'max:120'],
            'amount' => ['required', 'numeric', 'money', 'gt:0'],
            'source_ref' => ['required', 'string', 'max:120'],
        ]);

        app(PostObligation::class)->post(
            $this->actor(),
            FinancialPeriod::query()->findOrFail($input['period_id']),
            $input['student_id'],
            $input['source'],
            $input['reason'],
            [['category' => $input['category'], 'amount' => $input['amount'], 'source_ref' => $input['source_ref']]],
            $this->idempotencyKey('finance.obligation.post'),
        );

        return redirect()->route('finance.index')->with('success', 'Obligation posted.');
    }

    public function openFinancialPeriod(Request $request): RedirectResponse
    {
        $input = $request->validate([
            'period_key' => ['required', 'string', 'max:40'],
            'date_from' => ['required', 'date'],
            'date_to' => ['required', 'date', 'after_or_equal:date_from'],
        ]);

        app(MaintainFinancialPeriod::class)->open(
            $this->actor(),
            $input['period_key'],
            $input['date_from'],
            $input['date_to'],
            $this->idempotencyKey('finance.period.open'),
        );

        return redirect()->route('finance.index')->with('success', 'Financial period opened.');
    }

    public function closeFinancialPeriod(Request $request, string $periodId): RedirectResponse
    {
        app(MaintainFinancialPeriod::class)->close(
            $this->actor(),
            FinancialPeriod::query()->findOrFail($periodId),
            $this->idempotencyKey('finance.period.close'),
        );

        return redirect()->route('finance.index')->with('success', 'Financial period closed.');
    }

    public function defineAccount(Request $request): RedirectResponse
    {
        $input = $request->validate([
            'code' => ['required', 'string', 'max:40'],
            'name' => ['required', 'string', 'max:120'],
            'type' => ['required', 'in:asset,liability,equity,revenue,expense'],
        ]);

        app(MaintainChartOfAccounts::class)->define(
            $this->actor(),
            $input['code'],
            $input['name'],
            $input['type'],
            $this->idempotencyKey('finance.account.define'),
        );

        return redirect()->route('finance.index')->with('success', 'Account defined; the chart is immutable — a changed definition is a new account.');
    }

    public function postJournal(Request $request): RedirectResponse
    {
        // The form offers four line slots; unfilled slots are dropped before
        // the command sees the lines. A partially filled slot is invalid.
        $input = $request->validate([
            'period_id' => ['required', 'string'],
            'source_type' => ['required', 'in:obligation,payroll_result,journal,other'],
            'source_id' => ['nullable', 'string'],
            'reason' => ['required', 'string', 'max:1000'],
            'lines' => ['required', 'array', 'min:1', 'max:4'],
            'lines.*.account_id' => ['nullable', 'string'],
            'lines.*.direction' => ['nullable', 'in:debit,credit'],
            'lines.*.amount' => ['nullable', 'numeric', 'money', 'gt:0'],
        ]);

        $lines = [];
        foreach ($input['lines'] as $slot) {
            $filled = array_filter([$slot['account_id'] ?? '', $slot['direction'] ?? '', $slot['amount'] ?? ''], static fn (mixed $value): bool => $value !== '');
            if ($filled === []) {
                continue;
            }
            if (count($filled) !== 3) {
                throw ValidationException::withMessages(['lines' => 'every journal line needs an account, a direction and an amount']);
            }
            $lines[] = [
                'account_id' => $slot['account_id'],
                'direction' => $slot['direction'],
                'amount' => (string) $slot['amount'],
            ];
        }
        if ($lines === []) {
            throw ValidationException::withMessages(['lines' => 'at least one complete journal line is required']);
        }

        app(PostJournal::class)->post(
            $this->actor(),
            FinancialPeriod::query()->findOrFail($input['period_id']),
            $input['source_type'],
            (($input['source_id'] ?? '') !== '') ? $input['source_id'] : null,
            $input['reason'],
            $lines,
            $this->idempotencyKey('finance.journal.post'),
        );

        return redirect()->route('finance.index')->with('success', 'Journal posted; it must balance exactly and stays immutable (corrections append reversals).');
    }

    public function reverseJournal(Request $request, string $journalId): RedirectResponse
    {
        $input = $request->validate([
            'reason' => ['required', 'string', 'max:1000'],
        ]);

        app(PostJournal::class)->reverse(
            $this->actor(),
            Journal::query()->findOrFail($journalId),
            $input['reason'],
            $this->idempotencyKey('finance.journal.reverse'),
        );

        return redirect()->route('finance.index')->with('success', 'Reversal journal posted, linked to its original.');
    }

    public function proposeDiscount(Request $request): RedirectResponse
    {
        $input = $request->validate([
            'obligation_id' => ['required', 'string'],
            'period_id' => ['required', 'string'],
            'amount' => ['required', 'numeric', 'money', 'gt:0'],
            'eligibility' => ['required', 'string', 'max:500'],
            'effective_from' => ['required', 'date'],
            'effective_to' => ['nullable', 'date', 'after_or_equal:effective_from'],
            'reason' => ['required', 'string', 'max:1000'],
        ]);

        app(MaintainDiscount::class)->propose(
            $this->actor(),
            Obligation::query()->findOrFail($input['obligation_id']),
            FinancialPeriod::query()->findOrFail($input['period_id']),
            $input['amount'],
            $input['eligibility'],
            $input['effective_from'],
            (($input['effective_to'] ?? '') !== '') ? $input['effective_to'] : null,
            $input['reason'],
            $this->idempotencyKey('finance.discount.propose'),
        );

        return redirect()->route('finance.index')->with('success', 'Discount proposed; it takes effect once a distinct approver approves it.');
    }

    public function approveDiscount(Request $request, string $discountId): RedirectResponse
    {
        app(MaintainDiscount::class)->approve(
            $this->actor(),
            Discount::query()->findOrFail($discountId),
            $this->idempotencyKey('finance.discount.approve'),
        );

        return redirect()->route('finance.index')->with('success', 'Discount approved; the original charge is never rewritten.');
    }

    public function observeReconciliation(Request $request): RedirectResponse
    {
        $input = $request->validate([
            'period_id' => ['required', 'string'],
            'subject' => ['required', 'string', 'max:120'],
            'expected' => ['required', 'numeric', 'money'],
            'observed' => ['required', 'numeric', 'money'],
            'explanation' => ['nullable', 'string', 'max:1000'],
        ]);

        app(RecordReconciliation::class)->observe(
            $this->actor(),
            FinancialPeriod::query()->findOrFail($input['period_id']),
            $input['subject'],
            $input['expected'],
            $input['observed'],
            (($input['explanation'] ?? '') !== '') ? $input['explanation'] : null,
            $this->idempotencyKey('finance.reconciliation.observe'),
        );

        return redirect()->route('finance.index')->with('success', 'Reconciliation recorded; a variance is only valid with its explanation.');
    }

    public function approveReconciliation(Request $request, string $reconciliationId): RedirectResponse
    {
        app(RecordReconciliation::class)->approve(
            $this->actor(),
            Reconciliation::query()->findOrFail($reconciliationId),
            $this->idempotencyKey('finance.reconciliation.approve'),
        );

        return redirect()->route('finance.index')->with('success', 'Reconciliation approved; the observation is locked.');
    }

    public function establishFund(Request $request): RedirectResponse
    {
        $input = $request->validate([
            'name' => ['required', 'string', 'max:120'],
            'agreement_ref' => ['required', 'string', 'max:120'],
            'committed_amount' => ['required', 'numeric', 'money', 'gt:0'],
            'restricted_category' => ['nullable', 'string', 'max:120'],
            'restriction_note' => ['nullable', 'string', 'max:1000'],
        ]);

        app(AllocateFunds::class)->establish(
            $this->actor(),
            $input['name'],
            $input['agreement_ref'],
            $input['committed_amount'],
            (($input['restricted_category'] ?? '') !== '') ? $input['restricted_category'] : null,
            (($input['restriction_note'] ?? '') !== '') ? $input['restriction_note'] : null,
            $this->idempotencyKey('finance.fund.establish'),
        );

        return redirect()->route('finance.index')->with('success', 'Funding source established; the pool and its restriction are immutable.');
    }

    public function allocateFund(Request $request, string $fundId): RedirectResponse
    {
        $input = $request->validate([
            'obligation_line_id' => ['required', 'string'],
            'amount' => ['required', 'numeric', 'money', 'gt:0'],
            'reason' => ['required', 'string', 'max:1000'],
        ]);

        app(AllocateFunds::class)->allocate(
            $this->actor(),
            FundingSource::query()->findOrFail($fundId),
            ObligationLine::query()->findOrFail($input['obligation_line_id']),
            $input['amount'],
            $input['reason'],
            $this->idempotencyKey('finance.fund.allocate'),
        );

        return redirect()->route('finance.index')->with('success', 'Fund allocated to the obligation line.');
    }

    public function proposeCredit(Request $request): RedirectResponse
    {
        $input = $request->validate([
            'student_id' => ['required', 'string'],
            'amount' => ['required', 'numeric', 'money', 'gt:0'],
            'reason' => ['required', 'string', 'max:1000'],
            'source_ref' => ['required', 'string', 'max:120'],
        ]);

        app(MaintainFinancialCredit::class)->propose(
            $this->actor(),
            $input['student_id'],
            $input['amount'],
            $input['reason'],
            $input['source_ref'],
            $this->idempotencyKey('finance.credit.propose'),
        );

        return redirect()->route('finance.index')->with('success', 'Credit proposed; it authorizes a gate only after a distinct approver approves it.');
    }

    public function approveCredit(Request $request, string $creditId): RedirectResponse
    {
        app(MaintainFinancialCredit::class)->approve(
            $this->actor(),
            FinancialCredit::query()->findOrFail($creditId),
            $this->idempotencyKey('finance.credit.approve'),
        );

        return redirect()->route('finance.index')->with('success', 'Credit approved and locked.');
    }

    public function proposeInstallment(Request $request): RedirectResponse
    {
        $input = $request->validate([
            'student_id' => ['required', 'string'],
            'offering_id' => ['nullable', 'string'],
            'amount' => ['required', 'numeric', 'money', 'gt:0'],
            'installments_count' => ['required', 'integer', 'gt:0'],
            'first_due_on' => ['required', 'date'],
            'schedule_ref' => ['required', 'string', 'max:120'],
        ]);

        app(MaintainInstallmentPlan::class)->propose(
            $this->actor(),
            $input['student_id'],
            ($input['offering_id'] ?? '') !== '' ? $input['offering_id'] : null,
            $input['amount'],
            (int) $input['installments_count'],
            $input['first_due_on'],
            $input['schedule_ref'],
            $this->idempotencyKey('finance.installment.propose'),
        );

        return redirect()->route('finance.index')->with('success', 'Installment plan proposed; it authorizes a gate only after a distinct approver approves it.');
    }

    public function approveInstallment(Request $request, string $planId): RedirectResponse
    {
        app(MaintainInstallmentPlan::class)->approve(
            $this->actor(),
            EnrollmentInstallmentPlan::query()->findOrFail($planId),
            $this->idempotencyKey('finance.installment.approve'),
        );

        return redirect()->route('finance.index')->with('success', 'Installment plan approved and locked.');
    }

    public function proposeGateException(Request $request): RedirectResponse
    {
        $input = $request->validate([
            'student_id' => ['required', 'string'],
            'offering_id' => ['nullable', 'string'],
            'class_id' => ['nullable', 'string'],
            'amount' => ['required', 'numeric', 'money', 'gt:0'],
            'reason' => ['required', 'string', 'max:1000'],
            'effective_from' => ['required', 'date'],
            'effective_to' => ['nullable', 'date', 'after_or_equal:effective_from'],
        ]);

        app(MaintainFinancialGateException::class)->propose(
            $this->actor(),
            $input['student_id'],
            ($input['offering_id'] ?? '') !== '' ? $input['offering_id'] : null,
            ($input['class_id'] ?? '') !== '' ? $input['class_id'] : null,
            $input['amount'],
            $input['reason'],
            $input['effective_from'],
            ($input['effective_to'] ?? '') !== '' ? $input['effective_to'] : null,
            $this->idempotencyKey('finance.gate_exception.propose'),
        );

        return redirect()->route('finance.index')->with('success', 'Gate exception proposed; it takes effect only after a distinct approver approves it.');
    }

    public function approveGateException(Request $request, string $exceptionId): RedirectResponse
    {
        app(MaintainFinancialGateException::class)->approve(
            $this->actor(),
            FinancialGateException::query()->findOrFail($exceptionId),
            $this->idempotencyKey('finance.gate_exception.approve'),
        );

        return redirect()->route('finance.index')->with('success', 'Gate exception approved and locked.');
    }
}
