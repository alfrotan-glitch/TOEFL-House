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
use App\Support\Authorization\AccessDecision;
use App\Support\Authorization\Actor;
use App\Support\Errors\AuthorizationDenied;
use App\Support\Errors\BusinessRejection;
use App\Support\Idempotency\IdempotentExecution;
use App\Support\Identifiers\RandomIdentifier;
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
    public function post(Actor $actor, FinancialPeriod $period, string $sourceType, ?string $sourceId, string $reason, array $lines, string $idempotencyKey): array
    {
        $payload = hash('sha256', implode('|', ['finance.journal.post', $period->id, $sourceType, (string) $sourceId, $reason, json_encode($lines), $actor->actorId]));

        try {
            return $this->idempotency->execute('finance.journal.post', $idempotencyKey, $payload,
                fn (): array => DB::transaction(function () use ($actor, $period, $sourceType, $sourceId, $reason, $lines): array {
                    $this->require($actor);
                    [$debit, $credit] = $this->validate($sourceType, $sourceId, $reason, $lines);

                    /** @var FinancialPeriod $lockedPeriod */
                    $lockedPeriod = FinancialPeriod::query()->whereKey($period->id)->lockForUpdate()->firstOrFail();
                    if ($lockedPeriod->lifecycle_state !== FinanceLifecycle::PERIOD_OPEN) {
                        throw BusinessRejection::forCode('finance.period_not_open', 'journals post only to an open financial period');
                    }

                    $journal = Journal::query()->create([
                        'id' => RandomIdentifier::new(),
                        'period_id' => $lockedPeriod->id,
                        'source_type' => $sourceType,
                        'source_id' => $sourceId,
                        'reason' => $reason,
                        'posted_by' => $actor->actorId,
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
                        'period_id' => $lockedPeriod->id, 'source_type' => $sourceType, 'debit' => $debit, 'credit' => $credit,
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
        /** @var Journal $lockedOriginal */
        $lockedOriginal = Journal::query()->whereKey($original->id)->lockForUpdate()->firstOrFail();
        $lines = JournalLine::query()->where('journal_id', $lockedOriginal->id)
            ->get()
            ->map(static fn (JournalLine $line): array => [
                'account_id' => $line->account_id,
                'direction' => $line->direction === 'debit' ? 'credit' : 'debit',
                'amount' => (string) $line->amount,
            ])->all();

        return $this->post($actor, FinancialPeriod::query()->findOrFail($lockedOriginal->period_id), 'journal', $lockedOriginal->id, $reason, $lines, $idempotencyKey);
    }

    /**
     * @param  list<array{account_id: string, direction: string, amount: string}>  $lines
     * @return array{0: string, 1: string}
     */
    private function validate(string $sourceType, ?string $sourceId, string $reason, array $lines): array
    {
        if (! in_array($sourceType, ['obligation', 'payroll_result', 'journal', 'other'], true)) {
            throw BusinessRejection::forCode('finance.journal_source_unknown', sprintf('unknown journal source %s', $sourceType));
        }
        if ($reason === '') {
            throw BusinessRejection::forCode('finance.journal_reason', 'a journal requires a reason');
        }
        $debit = '0.00';
        $credit = '0.00';
        foreach ($lines as $line) {
            if (! in_array($line['direction'], ['debit', 'credit'], true)) {
                throw BusinessRejection::forCode('finance.journal_direction', 'journal lines are debit or credit');
            }
            if (! is_numeric($line['amount']) || (float) $line['amount'] <= 0) {
                throw BusinessRejection::forCode('finance.journal_amount', 'journal line amounts must be positive');
            }
            if (! Account::query()->whereKey($line['account_id'])->exists()) {
                throw BusinessRejection::forCode('finance.journal_account_unknown', 'a journal line references an unknown account');
            }
            if ($line['direction'] === 'debit') {
                $debit = bcadd($debit, (string) $line['amount'], 2);
            } else {
                $credit = bcadd($credit, (string) $line['amount'], 2);
            }
        }
        if (bccomp($debit, $credit, 2) !== 0) {
            throw BusinessRejection::forCode('finance.journal_unbalanced', sprintf('the journal does not balance: debit %s vs credit %s', $debit, $credit));
        }

        return [$debit, $credit];
    }

    private function require(Actor $actor): void
    {
        $outcome = $this->access->decide($actor, self::CAPABILITY, null);
        if (! $outcome->allowed) {
            throw AuthorizationDenied::forCode('finance.journal_denied', $outcome->reason);
        }
    }
}
