<?php

declare(strict_types=1);

namespace App\Modules\Finance\Domain;

use App\Modules\Finance\Models\Account;
use App\Modules\Finance\Models\Discount;
use App\Modules\Finance\Models\Expense;
use App\Modules\Finance\Models\FinancialCorrection;
use App\Modules\Finance\Models\FundAllocation;
use App\Modules\Finance\Models\Obligation;
use App\Modules\Finance\Models\Payment;
use App\Modules\Finance\Models\PayrollLiabilityFact;
use App\Modules\Finance\Models\Refund;
use App\Modules\Organization\Models\Branch;
use App\Support\Errors\BusinessRejection;

/**
 * Resolves the authoritative double-entry for a Finance source fact.
 *
 * The student-accounts-receivable subledger (obligations, discounts,
 * payments, refunds, fund allocations) and the payroll/expense payables are
 * operational detail records. This service is the single place that maps a
 * source fact to its general-ledger accounts so the GL provably mirrors the
 * money facts — the authoritative accounting truth. No other bounded context
 * reimplements this mapping.
 *
 * Account resolution is deterministic against the seeded standard school
 * chart (migration 000186); a missing required account is a configuration
 * failure and fails closed rather than silently posting to a wrong account.
 */
final class LedgerAccountResolver
{
    public const ACCOUNT_CASH = '1000';
    public const ACCOUNT_RECEIVABLE = '1100';
    public const ACCOUNT_PAYABLE = '2000';
    public const ACCOUNT_PAYROLL_PAYABLE = '2010';
    public const ACCOUNT_OPENING_EQUITY = '3000';
    public const ACCOUNT_TUITION_REVENUE = '4000';
    public const ACCOUNT_FEES_REVENUE = '4100';
    public const ACCOUNT_SALARY_EXPENSE = '5000';
    public const ACCOUNT_FINANCIAL_AID_EXPENSE = '5100';
    public const ACCOUNT_DISCOUNT_EXPENSE = '5200';
    public const ACCOUNT_OPERATING_EXPENSE = '6000';

    /** Revenue classification for obligation sources. */
    private const FEES_REVENUE_SOURCES = ['registration', 'application', 'admission', 'exam', 'test', 'transfer', 're-registration'];

    /**
     * @return array{debit_account_id: string, credit_account_id: string, amount: numeric-string, period_id: string, organization_id: string}
     */
    public function resolve(string $sourceType, string $sourceId): array
    {
        return match ($sourceType) {
            'obligation' => $this->resolveObligation($sourceId),
            'discount' => $this->resolveDiscount($sourceId),
            'payment' => $this->resolvePayment($sourceId),
            'refund' => $this->resolveRefund($sourceId),
            'fund_allocation' => $this->resolveFundAllocation($sourceId),
            'payroll_liability' => $this->resolvePayrollLiability($sourceId),
            'expense' => $this->resolveExpense($sourceId),
            'correction' => $this->resolveCorrection($sourceId),
            default => throw BusinessRejection::forCode('finance.ledger_source_unsupported', sprintf('there is no ledger mapping for journal source %s', $sourceType)),
        };
    }

    /** @return array{debit_account_id: string, credit_account_id: string, amount: numeric-string, period_id: string, organization_id: string} */
    private function resolveObligation(string $sourceId): array
    {
        /** @var Obligation|null $obligation */
        $obligation = Obligation::query()->whereKey($sourceId)->first();
        if ($obligation === null) {
            throw BusinessRejection::forCode('finance.ledger_source_unknown', 'the ledger obligation source is unknown');
        }
        $revenueCode = in_array(strtolower(trim((string) $obligation->source)), self::FEES_REVENUE_SOURCES, true)
            ? self::ACCOUNT_FEES_REVENUE
            : self::ACCOUNT_TUITION_REVENUE;

        return [
            'debit_account_id' => $this->accountId(self::ACCOUNT_RECEIVABLE),
            'credit_account_id' => $this->accountId($revenueCode),
            'amount' => (string) $obligation->original_amount,
            'period_id' => (string) $obligation->period_id,
            'organization_id' => $this->organizationForBranch($obligation->current_home_branch_id ?? $obligation->originating_branch_id),
        ];
    }

    /** @return array{debit_account_id: string, credit_account_id: string, amount: numeric-string, period_id: string, organization_id: string} */
    private function resolveDiscount(string $sourceId): array
    {
        /** @var Discount|null $discount */
        $discount = Discount::query()->whereKey($sourceId)->first();
        if ($discount === null) {
            throw BusinessRejection::forCode('finance.ledger_source_unknown', 'the ledger discount source is unknown');
        }
        $obligation = Obligation::query()->find($discount->obligation_id);

        return [
            'debit_account_id' => $this->accountId(self::ACCOUNT_DISCOUNT_EXPENSE),
            'credit_account_id' => $this->accountId(self::ACCOUNT_RECEIVABLE),
            'amount' => (string) $discount->amount,
            'period_id' => (string) $discount->period_id,
            'organization_id' => $this->organizationForBranch($obligation?->current_home_branch_id ?? $obligation?->originating_branch_id),
        ];
    }

    /** @return array{debit_account_id: string, credit_account_id: string, amount: numeric-string, period_id: string, organization_id: string} */
    private function resolvePayment(string $sourceId): array
    {
        /** @var Payment|null $payment */
        $payment = Payment::query()->whereKey($sourceId)->first();
        if ($payment === null) {
            throw BusinessRejection::forCode('finance.ledger_source_unknown', 'the ledger payment source is unknown');
        }

        return [
            'debit_account_id' => $this->accountId(self::ACCOUNT_CASH),
            'credit_account_id' => $this->accountId(self::ACCOUNT_RECEIVABLE),
            'amount' => (string) $payment->amount,
            'period_id' => (string) $payment->period_id,
            'organization_id' => $this->organizationForBranch($payment->current_home_branch_id ?? $payment->originating_branch_id),
        ];
    }

    /** @return array{debit_account_id: string, credit_account_id: string, amount: numeric-string, period_id: string, organization_id: string} */
    private function resolveRefund(string $sourceId): array
    {
        /** @var Refund|null $refund */
        $refund = Refund::query()->whereKey($sourceId)->first();
        if ($refund === null) {
            throw BusinessRejection::forCode('finance.ledger_source_unknown', 'the ledger refund source is unknown');
        }

        return [
            'debit_account_id' => $this->accountId(self::ACCOUNT_RECEIVABLE),
            'credit_account_id' => $this->accountId(self::ACCOUNT_CASH),
            'amount' => (string) $refund->amount,
            'period_id' => (string) $refund->period_id,
            'organization_id' => $this->organizationForBranch($refund->current_home_branch_id ?? $refund->originating_branch_id),
        ];
    }

    /** @return array{debit_account_id: string, credit_account_id: string, amount: numeric-string, period_id: string, organization_id: string} */
    private function resolveFundAllocation(string $sourceId): array
    {
        /** @var FundAllocation|null $allocation */
        $allocation = FundAllocation::query()->whereKey($sourceId)->first();
        if ($allocation === null) {
            throw BusinessRejection::forCode('finance.ledger_source_unknown', 'the ledger fund allocation source is unknown');
        }
        $obligation = Obligation::query()
            ->join('obligation_lines', 'obligation_lines.obligation_id', '=', 'obligations.id')
            ->where('obligation_lines.id', $allocation->obligation_line_id)
            ->select('obligations.*')
            ->first();

        return [
            'debit_account_id' => $this->accountId(self::ACCOUNT_FINANCIAL_AID_EXPENSE),
            'credit_account_id' => $this->accountId(self::ACCOUNT_RECEIVABLE),
            'amount' => (string) $allocation->amount,
            'period_id' => (string) $obligation?->period_id,
            'organization_id' => $this->organizationForBranch($allocation->current_home_branch_id ?? $allocation->originating_branch_id ?? $obligation?->current_home_branch_id ?? $obligation?->originating_branch_id),
        ];
    }

    /** @return array{debit_account_id: string, credit_account_id: string, amount: numeric-string, period_id: string, organization_id: string} */
    private function resolvePayrollLiability(string $sourceId): array
    {
        /** @var PayrollLiabilityFact|null $liability */
        $liability = PayrollLiabilityFact::query()->whereKey($sourceId)->first();
        if ($liability === null) {
            throw BusinessRejection::forCode('finance.ledger_source_unknown', 'the ledger payroll liability source is unknown');
        }
        $amount = (string) $liability->amount;
        $absoluteAmount = str_starts_with($amount, '-') ? substr($amount, 1) : $amount;

        return [
            'debit_account_id' => $this->accountId(self::ACCOUNT_SALARY_EXPENSE),
            'credit_account_id' => $this->accountId(self::ACCOUNT_PAYROLL_PAYABLE),
            'amount' => $absoluteAmount,
            'period_id' => (string) $liability->period_id,
            'organization_id' => $this->organizationForBranch($liability->originating_branch_id),
        ];
    }

    /** @return array{debit_account_id: string, credit_account_id: string, amount: numeric-string, period_id: string, organization_id: string} */
    private function resolveExpense(string $sourceId): array
    {
        /** @var Expense|null $expense */
        $expense = Expense::query()->whereKey($sourceId)->first();
        if ($expense === null) {
            throw BusinessRejection::forCode('finance.ledger_source_unknown', 'the ledger expense source is unknown');
        }

        return [
            'debit_account_id' => (string) $expense->expense_account_id,
            'credit_account_id' => $this->accountId(self::ACCOUNT_PAYABLE),
            'amount' => (string) $expense->amount,
            'period_id' => (string) $expense->period_id,
            'organization_id' => $this->organizationForBranch($expense->current_home_branch_id ?? $expense->originating_branch_id),
        ];
    }

    /**
     * Compensating correction mapping. An obligation adjustment re-states the
     * charge (and therefore AR and revenue) in the source period; a fund
     * allocation reversal undoes the financial-aid recognition. An allocation
     * reversal is a pure accounts-receivable reclassification (the payment
     * journal already moved cash against AR as a whole) and has no GL entry.
     *
     * @return array{debit_account_id: string, credit_account_id: string, amount: numeric-string, period_id: string, organization_id: string}
     */
    private function resolveCorrection(string $sourceId): array
    {
        /** @var FinancialCorrection|null $correction */
        $correction = FinancialCorrection::query()->whereKey($sourceId)->first();
        if ($correction === null) {
            throw BusinessRejection::forCode('finance.ledger_source_unknown', 'the ledger correction source is unknown');
        }

        if ($correction->correction_type === FinancialCorrection::TYPE_OBLIGATION_ADJUSTMENT) {
            /** @var Obligation|null $obligation */
            $obligation = Obligation::query()->whereKey($correction->obligation_id)->first();
            if ($obligation === null) {
                throw BusinessRejection::forCode('finance.ledger_source_unknown', 'the correction obligation source is unknown');
            }
            $revenueCode = in_array(strtolower(trim((string) $obligation->source)), self::FEES_REVENUE_SOURCES, true)
                ? self::ACCOUNT_FEES_REVENUE
                : self::ACCOUNT_TUITION_REVENUE;
            if ($correction->direction === FinancialCorrection::DIRECTION_DECREASE) {
                $debit = $this->accountId($revenueCode);
                $credit = $this->accountId(self::ACCOUNT_RECEIVABLE);
            } else {
                $debit = $this->accountId(self::ACCOUNT_RECEIVABLE);
                $credit = $this->accountId($revenueCode);
            }

            return [
                'debit_account_id' => $debit,
                'credit_account_id' => $credit,
                'amount' => (string) $correction->amount,
                'period_id' => (string) $correction->period_id,
                'organization_id' => $this->organizationForBranch($obligation->current_home_branch_id ?? $obligation->originating_branch_id),
            ];
        }

        if ($correction->correction_type === FinancialCorrection::TYPE_FUND_ALLOCATION_REVERSAL) {
            $lineId = (string) (FundAllocation::query()->whereKey($correction->fund_allocation_id)->value('obligation_line_id') ?? '');
            $obligation = $lineId === '' ? null : Obligation::query()
                ->join('obligation_lines', 'obligation_lines.obligation_id', '=', 'obligations.id')
                ->where('obligation_lines.id', $lineId)
                ->select('obligations.*')
                ->first();

            return [
                'debit_account_id' => $this->accountId(self::ACCOUNT_RECEIVABLE),
                'credit_account_id' => $this->accountId(self::ACCOUNT_FINANCIAL_AID_EXPENSE),
                'amount' => (string) $correction->amount,
                'period_id' => (string) $correction->period_id,
                'organization_id' => $this->organizationForBranch($obligation?->current_home_branch_id ?? $obligation?->originating_branch_id),
            ];
        }

        throw BusinessRejection::forCode('finance.ledger_correction_no_posting', 'an allocation reversal is a receivable reclassification and carries no general-ledger entry');
    }

    private function accountId(string $code): string
    {
        $account = Account::query()->where('code', $code)->first();
        if ($account === null) {
            throw BusinessRejection::forCode('finance.ledger_chart_incomplete', sprintf('the standard chart of accounts is missing account code %s; run the finance chart seed migration', $code));
        }

        return (string) $account->id;
    }

    private function organizationForBranch(?string $branchId): string
    {
        $branchId = trim((string) ($branchId ?? ''));
        if ($branchId === '') {
            throw BusinessRejection::forCode('finance.ledger_provenance_required', 'the ledger source requires branch provenance to anchor its organization');
        }
        $branch = Branch::query()->whereKey($branchId)->first();
        if ($branch === null) {
            throw BusinessRejection::forCode('finance.ledger_provenance_required', 'the ledger source branch provenance is unknown');
        }
        $organizationId = $branch->structureScope()->organizationId;
        if ($organizationId === '') {
            throw BusinessRejection::forCode('finance.ledger_provenance_required', 'the ledger source branch has no organization anchor');
        }

        return $organizationId;
    }
}
