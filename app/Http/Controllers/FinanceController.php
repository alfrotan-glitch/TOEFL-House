<?php

declare(strict_types=1);

namespace App\Http\Controllers;

use App\Modules\Finance\Commands\AllocateFunds;
use App\Modules\Finance\Commands\AllocatePayment;
use App\Modules\Finance\Commands\MaintainChartOfAccounts;
use App\Modules\Finance\Commands\MaintainEmploymentSettlement;
use App\Modules\Finance\Commands\MaintainDiscount;
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
use App\Modules\Finance\Models\Account;
use App\Modules\Finance\Models\Discount;
use App\Modules\Finance\Models\EnrollmentInstallmentPlan;
use App\Modules\Finance\Models\FinancialCorrection;
use App\Modules\Finance\Models\FinancialCoverageCommitment;
use App\Modules\Finance\Models\FinancialCoverageRevocation;
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
use App\Modules\Finance\Models\PaymentAllocation;
use App\Modules\Finance\Models\Reconciliation;
use App\Modules\Finance\Models\Refund;
use App\Modules\Hr\Models\Employment;
use App\Modules\Identity\Models\Person;
use App\Modules\Organization\Models\Branch;
use App\Modules\Organization\Models\Organization;
use App\Modules\Payroll\Models\SettlementProposal;
use App\Modules\Students\Models\Student;
use App\Support\Authorization\AccessDecision;
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
        $visible = [];
        foreach ([
            'finance.obligation', 'finance.payment', 'finance.refund', 'finance.refund_approve',
            'finance.discount', 'finance.discount_approve', 'finance.credit', 'finance.credit_approve',
            'finance.installment', 'finance.installment_approve', 'finance.gate_exception', 'finance.gate_exception_approve',
            'finance.coverage_revoke', 'finance.coverage_revoke_approve', 'finance.correct', 'finance.correct_approve', 'finance.period', 'finance.chart',
        ] as $capability) {
            $visible = array_merge($visible, $this->authorizedBranches($capability));
        }
        $visible = array_values(array_unique($visible, SORT_STRING));
        $globalFinanceAuthority = app(AccessDecision::class)->decide($this->actor(), 'finance.period', null)->allowed
            || app(AccessDecision::class)->decide($this->actor(), 'finance.chart', null)->allowed;
        $branchScoped = static function ($query) use ($visible): void {
            $query->whereIn('current_home_branch_id', $visible)
                ->orWhere(function ($query) use ($visible): void {
                    $query->whereNull('current_home_branch_id')->whereIn('originating_branch_id', $visible);
                });
        };
        $studentIds = Student::query()->where($branchScoped)->select('id');
        $obligationIds = Obligation::query()->where($branchScoped)->select('id');
        $paymentIds = Payment::query()->where($branchScoped)->select('id');
        $obligationLineIds = ObligationLine::query()->whereIn('obligation_id', $obligationIds)->select('id');
        $paymentAllocationIds = PaymentAllocation::query()->whereIn('payment_id', $paymentIds)->select('id');
        $financialCorrectionIds = FinancialCorrection::query()
            ->whereIn('obligation_id', $obligationIds)
            ->orWhereIn('payment_allocation_id', $paymentAllocationIds)
            ->orWhereIn('fund_allocation_id', FundAllocation::query()->whereIn('obligation_line_id', $obligationLineIds)->select('id'))
            ->select('id');
        $branchJournalIds = Journal::query()->where('source_type', 'obligation')->whereIn('source_id', $obligationIds)->select('id');
        $visibleJournalIds = Journal::query()->whereIn('id', $branchJournalIds)->orWhereIn('reversal_of_id', $branchJournalIds)->select('id');

        // Funding pools are Finance-owned organization facts, not global
        // reference data. A generic Finance/period/chart capability must not
        // disclose another organization's agreement, restriction, or pool.
        $fundEstablishOrganizationIds = $this->authorizedOrganizations(AllocateFunds::CAPABILITY_ESTABLISH);
        $fundingLineBranches = $this->authorizedBranches(AllocateFunds::CAPABILITY_ALLOCATE);
        // Allocation authority is evaluated on the concrete obligation branch.
        // Convert only those authorized branches to their current owning
        // organizations before reading source pools; an unrelated Finance
        // grant must never make a pool visible.
        $fundingAuthorityBranchOrganizations = Branch::query()
            ->whereIn('id', $fundingLineBranches)
            ->get()
            ->mapWithKeys(static fn (Branch $branch): array => [(string) $branch->id => $branch->structureScope()->organizationId]);
        $fundAllocateOrganizationIds = array_values(array_unique(array_merge(
            $this->authorizedOrganizations(AllocateFunds::CAPABILITY_ALLOCATE),
            $fundingAuthorityBranchOrganizations->filter(static fn (mixed $organizationId): bool => is_string($organizationId) && $organizationId !== '')->values()->all(),
        ), SORT_STRING));
        sort($fundAllocateOrganizationIds);
        $fundReadOrganizationIds = array_values(array_unique(array_merge($fundEstablishOrganizationIds, $fundAllocateOrganizationIds), SORT_STRING));
        sort($fundReadOrganizationIds);
        $fundingSources = FundingSource::query()
            ->whereIn('organization_id', $fundReadOrganizationIds)
            ->orderBy('name')
            ->get();
        $allocatableFundingSourceIds = $fundingSources
            ->whereIn('organization_id', $fundAllocateOrganizationIds)
            ->pluck('id')
            ->all();
        $fundingObligationLines = ObligationLine::query()
            ->whereIn('obligation_id', Obligation::query()->where(function ($query) use ($fundingLineBranches): void {
                $query->whereIn('current_home_branch_id', $fundingLineBranches)
                    ->orWhere(function ($query) use ($fundingLineBranches): void {
                        $query->whereNull('current_home_branch_id')->whereIn('originating_branch_id', $fundingLineBranches);
                    });
            })->select('id'))
            ->orderByDesc('id')
            ->limit(500)
            ->get();
        $fundingObligationBranches = Obligation::query()
            ->whereIn('id', $fundingObligationLines->pluck('obligation_id'))
            ->get(['id', 'current_home_branch_id', 'originating_branch_id'])
            ->mapWithKeys(static fn (Obligation $obligation): array => [
                (string) $obligation->id => trim((string) $obligation->current_home_branch_id) !== ''
                    ? trim((string) $obligation->current_home_branch_id)
                    : trim((string) $obligation->originating_branch_id),
            ]);
        $fundingBranchOrganizations = Branch::query()
            ->whereIn('id', $fundingObligationBranches->filter()->unique()->values())
            ->get()
            ->mapWithKeys(static fn (Branch $branch): array => [(string) $branch->id => $branch->structureScope()->organizationId]);
        $fundingObligationLinesByOrganization = $fundingObligationLines
            ->filter(static function (ObligationLine $line) use ($fundingObligationBranches, $fundingBranchOrganizations, $fundAllocateOrganizationIds): bool {
                $organizationId = $fundingBranchOrganizations->get($fundingObligationBranches->get($line->obligation_id, ''));

                return is_string($organizationId) && in_array($organizationId, $fundAllocateOrganizationIds, true);
            })
            ->groupBy(static fn (ObligationLine $line): string => (string) $fundingBranchOrganizations->get($fundingObligationBranches->get($line->obligation_id, '')));
        $fundEstablishOrganizations = Organization::query()
            ->whereIn('id', $fundEstablishOrganizationIds)
            ->where('lifecycle_state', 'active')
            ->orderBy('name')
            ->get(['id', 'name']);

        $globalPeriods = $globalFinanceAuthority ? FinancialPeriod::query()->orderBy('period_key')->get() : collect();
        $globalAccounts = $globalFinanceAuthority ? Account::query()->orderBy('code')->get() : collect();
        $globalReconciliations = $globalFinanceAuthority ? Reconciliation::query()->orderByDesc('id')->limit(100)->get() : collect();
        $journalQuery = $globalFinanceAuthority ? Journal::query() : Journal::query()->whereIn('id', $visibleJournalIds);
        $journalIds = $globalFinanceAuthority ? Journal::query()->select('id') : $visibleJournalIds;

        return view('finance.index', [
            'obligations' => Obligation::query()->whereIn('id', $obligationIds)->orderByDesc('id')->limit(200)->get(),
            'payments' => Payment::query()->where($branchScoped)->orderByDesc('received_on')->limit(200)->get(),
            'refunds' => Refund::query()->where($branchScoped)->where('lifecycle_state', 'recorded')->orderByDesc('id')->limit(200)->get(),
            'proposedRefunds' => Refund::query()->where($branchScoped)->where('lifecycle_state', 'proposed')->orderByDesc('id')->limit(200)->get(),
            'discounts' => Discount::query()->whereIn('obligation_id', $obligationIds)->orderByDesc('id')->limit(100)->get(),
            'credits' => FinancialCredit::query()->whereIn('student_id', $studentIds)->orderByDesc('id')->limit(100)->get(),
            'installmentPlans' => EnrollmentInstallmentPlan::query()->whereIn('student_id', $studentIds)->orderByDesc('id')->limit(100)->get(),
            'gateExceptions' => FinancialGateException::query()->whereIn('student_id', $studentIds)->orderByDesc('id')->limit(100)->get(),
            'fundingSources' => $fundingSources,
            'allocatableFundingSourceIds' => $allocatableFundingSourceIds,
            'fundingObligationLinesByOrganization' => $fundingObligationLinesByOrganization,
            'fundEstablishOrganizations' => $fundEstablishOrganizations,
            'fundOrganizationNames' => Organization::query()->whereIn('id', $fundReadOrganizationIds)->pluck('name', 'id'),
            'fundAllocations' => FundAllocation::query()
                ->whereIn('fund_id', $allocatableFundingSourceIds)
                ->orderByDesc('id')
                ->limit(200)
                ->get(),
            'financialCorrections' => FinancialCorrection::query()->whereIn('id', $financialCorrectionIds)->orderByDesc('id')->limit(200)->get(),
            'coverageCommitments' => FinancialCoverageCommitment::query()
                ->whereIn('obligation_id', $obligationIds)
                ->orderByDesc('id')
                ->limit(300)
                ->get(),
            'coverageRevocations' => FinancialCoverageRevocation::query()
                ->whereIn('student_id', $studentIds)
                ->orderByDesc('id')
                ->limit(200)
                ->get(),
            'periods' => $globalPeriods,
            'students' => Student::query()->whereIn('id', $studentIds)->orderBy('student_code')->limit(300)->get(),
            'accounts' => $globalAccounts,
            'journals' => $journalQuery->orderByDesc('id')->limit(100)->get(),
            'journalLines' => JournalLine::query()->whereIn('journal_id', $journalIds)->orderByDesc('id')->limit(500)->get(),
            'reconciliations' => $globalReconciliations,
            'obligationLines' => ObligationLine::query()->whereIn('id', $obligationLineIds)->orderByDesc('id')->limit(500)->get(),
        ]);
    }

    public function approveEmploymentSettlement(Request $request, string $proposalId): RedirectResponse
    {
        $employmentIds = Employment::query()
            ->whereIn('person_id', Person::query()->whereIn('home_branch_id', $this->authorizedBranches('finance.employment_settlement'))->select('id'))
            ->select('id');
        $proposal = SettlementProposal::query()->whereKey($proposalId)->whereIn('employment_id', $employmentIds)->firstOrFail();
        $employment = Employment::query()->whereIn('id', $employmentIds)->findOrFail($proposal->employment_id);
        app(MaintainEmploymentSettlement::class)->record(
            $this->actor(),
            $employment,
            (string) $proposal->id,
            (string) $proposal->amount,
            (string) $proposal->basis,
            (string) $proposal->prepared_by,
            $this->idempotencyKey('finance.employment-settlement.record'),
        );

        return redirect()->route('finance.index')->with('success', 'Employment settlement recorded by Finance.');
    }

    public function recognizePayrollLiability(Request $request): RedirectResponse
    {
        $input = $request->validate([
            'source_type' => ['required', 'in:payroll_result,payroll_adjustment'],
            'source_id' => ['required', 'string'],
            'amount' => ['required', 'numeric', 'signed_money'],
            'evidence_ref' => ['required', 'string', 'max:255'],
        ]);
        app(RecognizePayrollLiability::class)->recognize(
            $this->actor(), $input['source_type'], $input['source_id'], $input['amount'], $input['evidence_ref'],
            $this->idempotencyKey('finance.payroll-liability.recognize'),
        );

        return redirect()->route('finance.index')->with('success', 'Payroll source recognized as a Finance liability fact.');
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
            FinancialPeriod::query()->findOrFail((string) $input['period_id']),
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
            FinancialPeriod::query()->findOrFail((string) $input['period_id']),
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
            Payment::query()->findOrFail((string) $input['payment_id']),
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
            FinancialPeriod::query()->findOrFail((string) $input['period_id']),
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
            'source_type' => ['required', 'in:obligation,payroll_liability,other'],
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
            FinancialPeriod::query()->findOrFail((string) $input['period_id']),
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

    public function proposeObligationCorrection(Request $request, string $obligationId): RedirectResponse
    {
        $input = $request->validate([
            'amount' => ['required', 'numeric', 'money', 'gt:0'],
            'direction' => ['required', 'in:decrease,increase'],
            'reason' => ['required', 'string', 'max:1000'],
        ]);

        app(MaintainFinancialCorrection::class)->proposeObligationAdjustment(
            $this->actor(), Obligation::query()->findOrFail($obligationId), $input['amount'],
            $input['direction'], $input['reason'], $this->idempotencyKey('finance.correction.propose'),
        );

        return redirect()->route('finance.index')->with('success', 'Financial correction proposed; a distinct Finance approver must record it.');
    }

    public function proposeAllocationReversal(Request $request, string $allocationId): RedirectResponse
    {
        $input = $request->validate([
            'amount' => ['required', 'numeric', 'money', 'gt:0'],
            'reason' => ['required', 'string', 'max:1000'],
        ]);

        app(MaintainFinancialCorrection::class)->proposeAllocationReversal(
            $this->actor(), PaymentAllocation::query()->findOrFail($allocationId), $input['amount'],
            $input['reason'], $this->idempotencyKey('finance.correction.propose'),
        );

        return redirect()->route('finance.index')->with('success', 'Allocation reversal proposed; a distinct Finance approver must record it.');
    }

    public function approveFinancialCorrection(Request $request, string $correctionId): RedirectResponse
    {
        app(MaintainFinancialCorrection::class)->approve(
            $this->actor(), FinancialCorrection::query()->findOrFail($correctionId),
            $this->idempotencyKey('finance.correction.approve'),
        );

        return redirect()->route('finance.index')->with('success', 'Financial correction recorded as a compensating fact.');
    }

    public function proposeFundAllocationReversal(Request $request, string $allocationId): RedirectResponse
    {
        $input = $request->validate([
            'amount' => ['required', 'numeric', 'money', 'gt:0'],
            'reason' => ['required', 'string', 'max:1000'],
        ]);

        app(MaintainFinancialCorrection::class)->proposeFundAllocationReversal(
            $this->actor(), FundAllocation::query()->findOrFail($allocationId), $input['amount'],
            $input['reason'], $this->idempotencyKey('finance.correction.propose'),
        );

        return redirect()->route('finance.index')->with('success', 'Fund allocation reversal proposed; a distinct Finance approver must record it.');
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
            Obligation::query()->findOrFail((string) $input['obligation_id']),
            FinancialPeriod::query()->findOrFail((string) $input['period_id']),
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
            FinancialPeriod::query()->findOrFail((string) $input['period_id']),
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
            'organization_id' => ['required', 'string'],
            'name' => ['required', 'string', 'max:120'],
            'agreement_ref' => ['required', 'string', 'max:120'],
            'committed_amount' => ['required', 'numeric', 'money', 'gt:0'],
            'restricted_category' => ['nullable', 'string', 'max:120'],
            'restriction_note' => ['nullable', 'string', 'max:1000'],
        ]);

        app(AllocateFunds::class)->establish(
            $this->actor(),
            $input['organization_id'],
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
            ObligationLine::query()->findOrFail((string) $input['obligation_line_id']),
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

    public function proposeCoverageRevocation(Request $request): RedirectResponse
    {
        $input = $request->validate([
            'coverage_source_type' => ['required', 'in:financial_credit,enrollment_installment_plan,financial_gate_exception'],
            'coverage_source_id' => ['required', 'string', 'max:36'],
            'reason' => ['required', 'string', 'max:1000'],
        ]);
        app(RevokeFinancialCoverage::class)->propose(
            $this->actor(),
            $input['coverage_source_type'],
            $input['coverage_source_id'],
            $input['reason'],
            $this->idempotencyKey('finance.coverage-revocation.propose'),
        );

        return redirect()->route('finance.index')->with('success', 'Coverage-source revocation proposed; a different Finance approver must record it.');
    }

    public function approveCoverageRevocation(Request $request, string $revocationId): RedirectResponse
    {
        app(RevokeFinancialCoverage::class)->approve(
            $this->actor(),
            FinancialCoverageRevocation::query()->findOrFail($revocationId),
            $this->idempotencyKey('finance.coverage-revocation.approve'),
        );

        return redirect()->route('finance.index')->with('success', 'Coverage source revoked for future Finance gate assessments; its historical evidence remains preserved.');
    }
}
