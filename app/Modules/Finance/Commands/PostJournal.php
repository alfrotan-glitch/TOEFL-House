<?php

declare(strict_types=1);

namespace App\Modules\Finance\Commands;

use App\Modules\Audit\AttemptedOperation;
use App\Modules\Audit\AuditRecorder;
use App\Modules\Finance\Domain\FinanceLifecycle;
use App\Modules\Finance\Models\Account;
use App\Modules\Finance\Models\FinancialPeriod;
use App\Modules\Finance\Models\Journal;
use App\Modules\Finance\Models\JournalLine;
use App\Modules\Finance\Models\Obligation;
use App\Modules\Finance\Models\PayrollLiabilityFact;
use App\Modules\Organization\Models\Branch;
use App\Support\Authorization\AccessDecision;
use App\Support\Authorization\Actor;
use App\Support\Errors\AuthorizationDenied;
use App\Support\Errors\BusinessRejection;
use App\Support\Idempotency\IdempotentExecution;
use App\Support\Identifiers\RandomIdentifier;
use App\Support\MoneyAmount;
use Illuminate\Support\Facades\DB;

/**
 * Balanced accounting records: every journal must balance exactly, posts
 * only to an open period, and is immutable once posted — corrections
 * append reversal journals linked to their original.
 */
final class PostJournal
{
    public const CAPABILITY = 'finance.journal';

    public function __construct(
        private readonly AccessDecision $access,
        private readonly IdempotentExecution $idempotency,
        private readonly AuditRecorder $audit,
        private readonly AttemptedOperation $attemptedOperation,
    ) {}

    /**
     * @param  list<array{account_id: string, direction: string, amount: string}>  $lines
     * @return array{journal_id: string, correlation_id: string}
     */
    public function post(Actor $actor, FinancialPeriod $period, string $sourceType, ?string $sourceId, string $reason, array $lines, string $idempotencyKey, ?string $reversalOfId = null): array
    {
        $payload = hash('sha256', implode('|', ['finance.journal.post', $period->id, $sourceType, (string) $sourceId, $reason, json_encode($lines), $reversalOfId ?? '', $actor->actorId]));

        try {
            return $this->idempotency->execute('finance.journal.post', $idempotencyKey, $payload,
                fn (): array => DB::transaction(function () use ($actor, $period, $sourceType, $sourceId, $reason, $lines, $reversalOfId): array {
                    [$debit, $credit] = $this->validate($sourceType, $sourceId, $reason, $lines, $reversalOfId);
                    $scope = $this->scopeForJournalSource($sourceType, $sourceId, $reversalOfId);
                    $this->require($actor, $scope);
                    if ($reversalOfId !== null) {
                        if ($sourceType !== 'journal' || $sourceId !== $reversalOfId) {
                            throw BusinessRejection::forCode('finance.journal_reversal_link', 'a reversal must link its journal source exactly');
                        }
                        $original = Journal::query()->whereKey($reversalOfId)->lockForUpdate()->first();
                        if ($original === null || $original->reversal_of_id !== null) {
                            throw BusinessRejection::forCode('finance.journal_reversal_source', 'a reversal must link an original, non-reversal journal');
                        }
                        $this->assertExactInverse($original, $lines);
                    }

                    /** @var FinancialPeriod $lockedPeriod */
                    $lockedPeriod = FinancialPeriod::query()->whereKey($period->id)->lockForUpdate()->firstOrFail();
                    if ($lockedPeriod->lifecycle_state !== FinanceLifecycle::PERIOD_OPEN) {
                        throw BusinessRejection::forCode('finance.period_not_open', 'journals post only to an open financial period');
                    }

                    // Payroll calculation/results remain Payroll evidence. A Finance
                    // recognition is the monetary source, and one liability fact may
                    // be disbursed exactly once. The partial unique index is the
                    // concurrency-safe backstop; this check returns a clean 409.
                    if ($sourceType === 'payroll_liability') {
                        $liability = $this->payrollLiability($sourceId);
                        $this->assertPayrollLiabilityAmount($liability, $debit, $credit);
                        if (Journal::query()->where('source_type', 'payroll_liability')->where('source_id', $liability->id)->exists()) {
                            throw BusinessRejection::forCode('finance.payroll_already_paid', 'this Finance payroll liability is already disbursed; correct it with a reversal');
                        }
                    }

                    $journal = Journal::query()->create([
                        'id' => RandomIdentifier::new(),
                        'period_id' => $lockedPeriod->id,
                        'source_type' => $sourceType,
                        'source_id' => $sourceId,
                        'reason' => $reason,
                        'posted_by' => $actor->actorId,
                        'reversal_of_id' => $reversalOfId,
                    ]);
                    foreach ($lines as $line) {
                        JournalLine::query()->create([
                            'id' => RandomIdentifier::new(),
                            'journal_id' => $journal->id,
                            'account_id' => $line['account_id'],
                            'direction' => $line['direction'],
                            'amount' => $line['amount'],
                        ]);
                    }
                    $event = $this->audit->record($actor->actorId, 'finance.journal.post', 'journal', $journal->id, null, [
                        'period_id' => $lockedPeriod->id, 'source_type' => $sourceType, 'branch_id' => $scope?->branchId, 'organization_id' => $scope?->organizationId, 'debit' => $debit, 'credit' => $credit,
                    ]);

                    return ['journal_id' => $journal->id, 'correlation_id' => $event->correlation_id];
                }),
            );
        } catch (AuthorizationDenied $denial) {
            $this->attemptedOperation->deniedByActor($denial, $actor, 'finance.journal.post', 'journal', (string) $sourceId);
        }
    }

    /** @return array{journal_id: string, correlation_id: string} */
    public function reverse(Actor $actor, Journal $original, string $reason, string $idempotencyKey): array
    {
        return DB::transaction(function () use ($actor, $original, $reason, $idempotencyKey): array {
            /** @var Journal $lockedOriginal */
            $lockedOriginal = Journal::query()->whereKey($original->id)->lockForUpdate()->firstOrFail();
            if ($lockedOriginal->reversal_of_id !== null) {
                throw BusinessRejection::forCode('finance.journal_reversal_of_reversal', 'a reversal cannot itself be reversed');
            }
            if (Journal::query()->where('reversal_of_id', $lockedOriginal->id)->exists()) {
                throw BusinessRejection::forCode('finance.journal_already_reversed', 'this journal already has a compensating reversal');
            }
            $lines = array_values(JournalLine::query()->where('journal_id', $lockedOriginal->id)
                ->get()
                ->map(static fn (JournalLine $line): array => [
                    'account_id' => $line->account_id,
                    'direction' => $line->direction === 'debit' ? 'credit' : 'debit',
                    'amount' => (string) $line->amount,
                ])->values()->all());

            return $this->post(
                $actor,
                FinancialPeriod::query()->findOrFail($lockedOriginal->period_id),
                'journal',
                $lockedOriginal->id,
                $reason,
                $lines,
                $idempotencyKey,
                $lockedOriginal->id,
            );
        });
    }

    /**
     * @param  list<array{account_id: string, direction: string, amount: string}>  $lines
     * @return array{0: string, 1: string}
     */
    private function validate(string $sourceType, ?string $sourceId, string $reason, array $lines, ?string $reversalOfId): array
    {
        if ($sourceType === 'payroll_result') {
            throw BusinessRejection::forCode('finance.journal_payroll_source_retired', 'a payroll disbursement must reference its Finance-recognized payroll liability, not a Payroll result directly');
        }
        if (! in_array($sourceType, ['obligation', 'payroll_liability', 'journal', 'other'], true)) {
            throw BusinessRejection::forCode('finance.journal_source_unknown', sprintf('unknown journal source %s', $sourceType));
        }
        if ($reason === '') {
            throw BusinessRejection::forCode('finance.journal_reason', 'a journal requires a reason');
        }
        if ($lines === []) {
            throw BusinessRejection::forCode('finance.journal_lines_required', 'a journal requires at least one complete line');
        }
        if (in_array($sourceType, ['obligation', 'payroll_liability'], true) && trim((string) $sourceId) === '') {
            throw BusinessRejection::forCode('finance.journal_source_required', sprintf('a %s journal requires its source id', str_replace('_', ' ', $sourceType)));
        }
        if ($sourceType === 'journal' && ($sourceId === null || $sourceId === '' || $reversalOfId === null)) {
            throw BusinessRejection::forCode('finance.journal_reversal_source', 'a journal reversal requires its original journal source');
        }
        if ($sourceType !== 'journal' && $reversalOfId !== null) {
            throw BusinessRejection::forCode('finance.journal_reversal_link', 'only a journal reversal may carry a reversal source');
        }
        $debit = '0.00';
        $credit = '0.00';
        foreach ($lines as $line) {
            if (! in_array($line['direction'], ['debit', 'credit'], true)) {
                throw BusinessRejection::forCode('finance.journal_direction', 'journal lines are debit or credit');
            }
            $lineAmount = MoneyAmount::decimal($line['amount']);
            if (! MoneyAmount::positive($lineAmount)) {
                throw BusinessRejection::forCode('finance.journal_amount', 'journal line amounts must be positive');
            }
            if (! Account::query()->whereKey($line['account_id'])->exists()) {
                throw BusinessRejection::forCode('finance.journal_account_unknown', 'a journal line references an unknown account');
            }
            if ($line['direction'] === 'debit') {
                $debit = bcadd($debit, $lineAmount, 2);
            } else {
                $credit = bcadd($credit, $lineAmount, 2);
            }
        }
        if (bccomp($debit, $credit, 2) !== 0) {
            throw BusinessRejection::forCode('finance.journal_unbalanced', sprintf('the journal does not balance: debit %s vs credit %s', $debit, $credit));
        }

        return [$debit, $credit];
    }

    private function scopeForJournalSource(string $sourceType, ?string $sourceId, ?string $reversalOfId): ?\App\Support\Authorization\StructureScope
    {
        if ($reversalOfId !== null) {
            $original = Journal::query()->whereKey($reversalOfId)->first();
            if ($original === null) {
                throw BusinessRejection::forCode('finance.journal_reversal_source', 'a reversal must link an existing journal');
            }
            $sourceType = (string) $original->source_type;
            $sourceId = $original->source_id;
        }
        if ($sourceType === 'obligation') {
            $obligation = $sourceId === null ? null : Obligation::query()->whereKey($sourceId)->first();
            if ($obligation === null) {
                throw BusinessRejection::forCode('finance.journal_source_unknown', 'the journal obligation source is unknown');
            }
            $branchId = trim((string) ($obligation->current_home_branch_id ?? $obligation->originating_branch_id ?? ''));
            $branch = $branchId === '' ? null : Branch::query()->whereKey($branchId)->first();
            if ($branch === null) {
                throw BusinessRejection::forCode('finance.journal_provenance_required', 'an obligation journal requires known branch provenance');
            }

            return $branch->structureScope();
        }
        if ($sourceType === 'payroll_liability') {
            $liability = $this->payrollLiability($sourceId);
            $branchId = trim((string) $liability->originating_branch_id);
            $branch = $branchId === '' ? null : Branch::query()->whereKey($branchId)->first();
            if ($branch === null) {
                throw BusinessRejection::forCode('finance.journal_provenance_required', 'a payroll liability journal requires known Finance branch provenance');
            }

            return $branch->structureScope();
        }

        // `other` is an explicit organization-wide accounting source. Legacy
        // payroll_result journals remain readable/reversible, but new writes
        // are rejected before this point and therefore cannot bypass Finance
        // recognition.
        return null;
    }

    private function payrollLiability(?string $sourceId): PayrollLiabilityFact
    {
        /** @var PayrollLiabilityFact|null $liability */
        $liability = $sourceId === null ? null : PayrollLiabilityFact::query()->whereKey($sourceId)->lockForUpdate()->first();
        if ($liability === null) {
            throw BusinessRejection::forCode('finance.journal_source_unknown', 'the Finance payroll liability source is unknown');
        }

        return $liability;
    }

    /** @param numeric-string $debit @param numeric-string $credit */
    private function assertPayrollLiabilityAmount(PayrollLiabilityFact $liability, string $debit, string $credit): void
    {
        $amount = (string) $liability->amount;
        $absoluteAmount = str_starts_with($amount, '-') ? substr($amount, 1) : $amount;
        if (bccomp($debit, $absoluteAmount, 2) !== 0 || bccomp($credit, $absoluteAmount, 2) !== 0) {
            throw BusinessRejection::forCode('finance.payroll_liability_amount_mismatch', 'a payroll liability journal must equal the absolute amount of its Finance liability fact');
        }
    }

    /**
     * @param list<array{account_id: string, direction: string, amount: string}> $lines
     */
    private function assertExactInverse(Journal $original, array $lines): void
    {
        $expected = [];
        foreach (JournalLine::query()->where('journal_id', $original->id)->orderBy('id')->get() as $line) {
            $key = $line->account_id.'|'.($line->direction === 'debit' ? 'credit' : 'debit');
            $expected[$key] = bcadd($expected[$key] ?? '0.00', (string) $line->amount, 2);
        }
        ksort($expected, SORT_STRING);
        if ($expected === [] || $expected !== $this->lineTotals($lines)) {
            throw BusinessRejection::forCode('finance.journal_reversal_lines_mismatch', 'a reversal journal must be an exact inverse of its original journal lines');
        }
    }

    /**
     * @param list<array{account_id: string, direction: string, amount: string}> $lines
     * @return array<string, numeric-string>
     */
    private function lineTotals(array $lines): array
    {
        $totals = [];
        foreach ($lines as $line) {
            $key = $line['account_id'].'|'.$line['direction'];
            $totals[$key] = bcadd($totals[$key] ?? '0.00', MoneyAmount::decimal($line['amount']), 2);
        }
        ksort($totals, SORT_STRING);

        return $totals;
    }

    private function require(Actor $actor, ?\App\Support\Authorization\StructureScope $scope): void
    {
        $outcome = $this->access->decide($actor, self::CAPABILITY, $scope);
        if (! $outcome->allowed) {
            throw AuthorizationDenied::forCode('finance.journal_denied', $outcome->reason);
        }
    }
}
