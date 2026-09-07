<?php

declare(strict_types=1);

namespace App\Modules\Finance\Queries;

use App\Modules\Finance\Models\Journal;
use App\Modules\Finance\Models\Discount;
use App\Modules\Finance\Models\Expense;
use App\Modules\Finance\Models\FundAllocation;
use App\Modules\Finance\Models\Obligation;
use App\Modules\Finance\Models\Payment;
use App\Modules\Finance\Models\PayrollLiabilityFact;
use App\Modules\Finance\Models\Refund;
use App\Support\MoneyAmount;
use Illuminate\Support\Facades\DB;

/**
 * Finance's authoritative general-ledger read model.
 *
 * Journal lines are the double-entry accounting truth; source facts are the
 * operational detail that resolves to those lines. This query returns the GL
 * as an accountant expects it — a trial balance by account, the detail ledger,
 * and a completeness proof that every money fact is journalized. No other
 * bounded context reimplements the ledger arithmetic.
 */
final class GeneralLedgerQuery
{
    /** @return array{totals: array{debit: string, credit: string, net: string}, accounts: array<int, array{account_id: string, code: string, name: string, type: string, debit: string, credit: string, net: string}>, balanced: bool} */
    public function trialBalance(?string $periodId = null, ?string $organizationId = null): array
    {
        $query = DB::table('journal_lines as jl')
            ->join('journals as j', 'j.id', '=', 'jl.journal_id')
            ->join('accounts as a', 'a.id', '=', 'jl.account_id')
            ->selectRaw('a.id AS account_id, a.code AS code, a.name AS name, a.type AS type')
            ->selectRaw('COALESCE(SUM(jl.amount) FILTER (WHERE jl.direction = \'debit\'), 0) AS debit')
            ->selectRaw('COALESCE(SUM(jl.amount) FILTER (WHERE jl.direction = \'credit\'), 0) AS credit')
            ->groupBy('a.id', 'a.code', 'a.name', 'a.type')
            ->orderBy('a.code');

        if ($periodId !== null && $periodId !== '') {
            $query->where('j.period_id', $periodId);
        }
        if ($organizationId !== null && $organizationId !== '') {
            $query->where('j.organization_id', $organizationId);
        }

        $accounts = [];
        $totalDebit = '0.00';
        $totalCredit = '0.00';
        foreach ($query->get() as $row) {
            $net = bcsub((string) $row->debit, (string) $row->credit, 2);
            $totalDebit = bcadd($totalDebit, (string) $row->debit, 2);
            $totalCredit = bcadd($totalCredit, (string) $row->credit, 2);
            $accounts[] = [
                'account_id' => (string) $row->account_id,
                'code' => (string) $row->code,
                'name' => (string) $row->name,
                'type' => (string) $row->type,
                'debit' => (string) $row->debit,
                'credit' => (string) $row->credit,
                'net' => $net,
            ];
        }
        $totalNet = bcsub($totalDebit, $totalCredit, 2);

        return [
            'totals' => ['debit' => $totalDebit, 'credit' => $totalCredit, 'net' => $totalNet],
            'accounts' => $accounts,
            'balanced' => bccomp($totalDebit, $totalCredit, 2) === 0,
        ];
    }

    /** @return array<int, array{journals: array{journal_id: string, entry_id: string, posted_at: string, source_type: string, reason: string}, line: array{direction: string, amount: string}}> */
    public function accountDetail(string $accountId, ?string $periodId = null, ?string $organizationId = null): array
    {
        $query = DB::table('journal_lines as jl')
            ->join('journals as j', 'j.id', '=', 'jl.journal_id')
            ->where('jl.account_id', $accountId)
            ->select('j.id AS journal_id', 'j.created_at AS posted_at', 'j.source_type', 'j.reason', 'jl.direction', 'jl.amount')
            ->orderBy('j.created_at')
            ->orderBy('jl.id');

        if ($periodId !== null && $periodId !== '') {
            $query->where('j.period_id', $periodId);
        }
        if ($organizationId !== null && $organizationId !== '') {
            $query->where('j.organization_id', $organizationId);
        }

        $rows = [];
        foreach ($query->get() as $row) {
            $rows[] = [
                'journals' => [
                    'journal_id' => (string) $row->journal_id,
                    'entry_id' => (string) $row->journal_id,
                    'posted_at' => (string) $row->posted_at,
                    'source_type' => (string) $row->source_type,
                    'reason' => (string) $row->reason,
                ],
                'line' => ['direction' => (string) $row->direction, 'amount' => (string) $row->amount],
            ];
        }

        return $rows;
    }

    /**
     * @return array{total: int, resolved: int, check_total: string, unresolved: array<int, array{source_type: string, source_id: string, amount: string, period_id: string}>}
     */
    public function completeness(?string $periodId = null): array
    {
        $hasPeriod = $periodId !== null && $periodId !== '';
        $scoped = static fn (\Illuminate\Database\Eloquent\Builder $query, string $column = 'period_id'): \Illuminate\Database\Eloquent\Builder => $hasPeriod ? $query->where($column, $periodId) : $query;

        $providers = [
            'obligation' => fn (): \Illuminate\Support\Collection => $scoped(Obligation::query())->pluck('id'),
            'payment' => fn (): \Illuminate\Support\Collection => $scoped(Payment::query())->pluck('id'),
            'discount' => fn (): \Illuminate\Support\Collection => $scoped(Discount::query()->where('lifecycle_state', 'approved'))->pluck('id'),
            'refund' => fn (): \Illuminate\Support\Collection => $scoped(Refund::query()->where('lifecycle_state', 'recorded'))->pluck('id'),
            'fund_allocation' => fn (): \Illuminate\Support\Collection => $scoped(
                FundAllocation::query()
                    ->join('obligation_lines', 'obligation_lines.id', '=', 'fund_allocations.obligation_line_id')
                    ->join('obligations', 'obligations.id', '=', 'obligation_lines.obligation_id'),
                'obligations.period_id',
            )->pluck('fund_allocations.id'),
            'payroll_liability' => fn (): \Illuminate\Support\Collection => $scoped(PayrollLiabilityFact::query())->pluck('id'),
            'expense' => fn (): \Illuminate\Support\Collection => $scoped(Expense::query()->where('lifecycle_state', 'approved'))->pluck('id'),
        ];

        // Key journalized facts by (source_type, source_id) so a ledger entry is
        // attributed to exactly the fact that produced it even across a shared
        // id space.
        $journalized = Journal::query()
            ->whereNotNull('source_id')
            ->when($periodId !== null && $periodId !== '', fn ($query) => $query->where('period_id', $periodId))
            ->get(['source_type', 'source_id'])
            ->mapWithKeys(static fn (Journal $journal): array => [$journal->source_type.'|'.$journal->source_id => true]);

        $unresolved = [];
        $total = 0;
        $resolved = 0;
        $checkTotal = '0.00';
        foreach ($providers as $sourceType => $provider) {
            foreach ($provider() as $sourceId) {
                $sourceId = (string) $sourceId;
                $total++;
                if ($journalized->has($sourceType.'|'.$sourceId)) {
                    $resolved++;

                    continue;
                }
                $amount = $this->sourceAmount($sourceType, $sourceId);
                $checkTotal = bcadd($checkTotal, $amount, 2);
                $unresolved[] = [
                    'source_type' => $sourceType,
                    'source_id' => $sourceId,
                    'amount' => $amount,
                    'period_id' => $this->sourcePeriod($sourceType, $sourceId),
                ];
            }
        }

        return [
            'total' => $total,
            'resolved' => $resolved,
            'check_total' => $checkTotal,
            'unresolved' => $unresolved,
        ];
    }

    private function sourceAmount(string $sourceType, string $sourceId): string
    {
        return match ($sourceType) {
            'obligation' => (string) (Obligation::query()->whereKey($sourceId)->value('original_amount') ?? '0.00'),
            'payment' => (string) (Payment::query()->whereKey($sourceId)->value('amount') ?? '0.00'),
            'discount' => (string) (Discount::query()->whereKey($sourceId)->value('amount') ?? '0.00'),
            'refund' => (string) (Refund::query()->whereKey($sourceId)->value('amount') ?? '0.00'),
            'fund_allocation' => (string) (FundAllocation::query()->whereKey($sourceId)->value('amount') ?? '0.00'),
            'payroll_liability' => $this->absolute((string) (PayrollLiabilityFact::query()->whereKey($sourceId)->value('amount') ?? '0.00')),
            'expense' => (string) (Expense::query()->whereKey($sourceId)->value('amount') ?? '0.00'),
            default => '0.00',
        };
    }

    private function sourcePeriod(string $sourceType, string $sourceId): string
    {
        return match ($sourceType) {
            'obligation' => (string) (Obligation::query()->whereKey($sourceId)->value('period_id') ?? ''),
            'payment' => (string) (Payment::query()->whereKey($sourceId)->value('period_id') ?? ''),
            'discount' => (string) (Discount::query()->whereKey($sourceId)->value('period_id') ?? ''),
            'refund' => (string) (Refund::query()->whereKey($sourceId)->value('period_id') ?? ''),
            'fund_allocation' => (string) (Obligation::query()->join('obligation_lines', 'obligation_lines.obligation_id', '=', 'obligations.id')->where('obligation_lines.id', FundAllocation::query()->whereKey($sourceId)->value('obligation_line_id'))->value('obligations.period_id') ?? ''),
            'payroll_liability' => (string) (PayrollLiabilityFact::query()->whereKey($sourceId)->value('period_id') ?? ''),
            'expense' => (string) (Expense::query()->whereKey($sourceId)->value('period_id') ?? ''),
            default => '',
        };
    }

    private function absolute(string $amount): string
    {
        return str_starts_with($amount, '-') ? substr($amount, 1) : $amount;
    }
}
