<?php

declare(strict_types=1);

namespace App\Modules\Finance\Commands;

use App\Modules\Audit\AuditRecorder;
use App\Modules\Finance\Domain\LedgerAccountResolver;
use App\Modules\Finance\Models\Journal;
use App\Modules\Finance\Models\JournalLine;
use App\Support\Authorization\Actor;
use App\Support\Errors\BusinessRejection;
use App\Support\Identifiers\RandomIdentifier;
use App\Support\MoneyAmount;

/**
 * Posts the authoritative double-entry journal for a Finance source fact.
 *
 * Every money fact is an operational detail record; its accounting effect must
 * be represented in the general ledger exactly once. This service is called
 * inside the same transaction as the fact so a fact and its journal are
 * atomic — a fact can never exist without its accounting entry. The
 * exactly-once invariant is enforced by a partial unique index at the database
 * boundary in addition to this application-level pre-check.
 */
final class LedgerPoster
{
    public function __construct(
        private readonly LedgerAccountResolver $accounts,
        private readonly AuditRecorder $audit,
    ) {}

    /**
     * @return array{journal_id: string, correlation_id: string, debit_account_id: string, credit_account_id: string, amount: numeric-string}
     */
    public function post(Actor $actor, string $sourceType, string $sourceId): array
    {
        $resolved = $this->accounts->resolve($sourceType, $sourceId);
        $amount = MoneyAmount::decimal($resolved['amount']);

        // Exactly-once is guarded by a partial unique index at the database
        // boundary; this application-level check returns a real journal for a
        // fact already posted so retried idempotent operations and legacy
        // pre-convergence facts resolve cleanly instead of double-posting.
        $existing = Journal::query()->where('source_type', $sourceType)->where('source_id', $sourceId)->first();
        if ($existing !== null) {
            $debit = JournalLine::query()->where('journal_id', $existing->id)->where('direction', 'debit')->first();
            $credit = JournalLine::query()->where('journal_id', $existing->id)->where('direction', 'credit')->first();

            return [
                'journal_id' => (string) $existing->id,
                'correlation_id' => '',
                'debit_account_id' => (string) $debit?->account_id,
                'credit_account_id' => (string) $credit?->account_id,
                'amount' => $amount,
            ];
        }

        $journal = Journal::query()->create([
            'id' => RandomIdentifier::new(),
            'period_id' => $resolved['period_id'],
            'source_type' => $sourceType,
            'source_id' => $sourceId,
            'reason' => $this->reasonFor($sourceType, $sourceId),
            'posted_by' => $actor->actorId,
            'organization_id' => $resolved['organization_id'],
            'reversal_of_id' => null,
        ]);

        JournalLine::query()->create([
            'id' => RandomIdentifier::new(),
            'journal_id' => $journal->id,
            'account_id' => $resolved['debit_account_id'],
            'direction' => 'debit',
            'amount' => $amount,
        ]);
        JournalLine::query()->create([
            'id' => RandomIdentifier::new(),
            'journal_id' => $journal->id,
            'account_id' => $resolved['credit_account_id'],
            'direction' => 'credit',
            'amount' => $amount,
        ]);

        $event = $this->audit->record($actor->actorId, 'finance.journal.auto_post', 'journal', $journal->id, null, [
            'source_type' => $sourceType,
            'source_id' => $sourceId,
            'debit_account_id' => $resolved['debit_account_id'],
            'credit_account_id' => $resolved['credit_account_id'],
            'amount' => $amount,
            'organization_id' => $resolved['organization_id'],
            'period_id' => $resolved['period_id'],
        ]);

        return [
            'journal_id' => (string) $journal->id,
            'correlation_id' => (string) $event->correlation_id,
            'debit_account_id' => $resolved['debit_account_id'],
            'credit_account_id' => $resolved['credit_account_id'],
            'amount' => $amount,
        ];
    }

    private function reasonFor(string $sourceType, string $sourceId): string
    {
        return sprintf('Automatic general-ledger posting for %s source %s', str_replace('_', ' ', $sourceType), $sourceId);
    }
}
