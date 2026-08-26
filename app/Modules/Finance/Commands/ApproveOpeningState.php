<?php

declare(strict_types=1);

namespace App\Modules\Finance\Commands;

use App\Modules\Audit\AttemptedOperation;
use App\Modules\Audit\AuditRecorder;
use App\Modules\Finance\Domain\FinanceLifecycle;
use App\Modules\Finance\Domain\OpeningEntryContract;
use App\Modules\Finance\Models\FinancialPeriod;
use App\Modules\Finance\Models\OpeningEntry;
use App\Modules\Finance\Models\OpeningMaterialization;
use App\Modules\Finance\Models\OpeningState;
use App\Support\Authorization\AccessDecision;
use App\Support\Authorization\Actor;
use App\Support\Errors\AuthorizationDenied;
use App\Support\Errors\BusinessRejection;
use App\Support\Idempotency\IdempotentExecution;
use App\Support\Identifiers\RandomIdentifier;
use Illuminate\Support\Facades\DB;

/**
 * Opening-state approval (General Manager): one atomic governance event.
 * Approval validates the submitted state and every entry, requires a
 * distinct approver, forbids a second opening state, then freezes the
 * state with immutable evidence and materializes the opening facts into
 * the certified financial instruments — receivables become obligations
 * (the only instrument payments can allocate against), cash positions
 * become balanced journals — all under the preparer's posting authority,
 * released by the approver's decision. Payables remain authoritative
 * opening liabilities settled later through normal journals.
 */
final class ApproveOpeningState
{
    public const CAPABILITY = 'finance.opening.approve';

    public function __construct(
        private readonly AccessDecision $access,
        private readonly IdempotentExecution $idempotency,
        private readonly AuditRecorder $audit,
        private readonly AttemptedOperation $attemptedOperation,
        private readonly PostObligation $obligations,
        private readonly PostJournal $journals,
    ) {}

    /** @return array{opening_state_id: string, approval_digest: string, obligations: int, journals: int, correlation_id: string} */
    public function approve(Actor $approver, OpeningState $state, string $idempotencyKey): array
    {
        $payload = hash('sha256', implode('|', ['finance.opening.approve', $state->id, $approver->actorId]));

        try {
            return $this->idempotency->execute('finance.opening.approve', $idempotencyKey, $payload,
                fn (): array => DB::transaction(function () use ($approver, $state): array {
                    $this->require($approver);

                    /** @var OpeningState $locked */
                    $locked = OpeningState::query()->whereKey($state->id)->lockForUpdate()->firstOrFail();
                    if ($locked->status === OpeningState::STATUS_APPROVED) {
                        throw BusinessRejection::forCode('finance.opening_frozen', 'this opening state is already approved and immutable');
                    }
                    if ($locked->status !== OpeningState::STATUS_SUBMITTED) {
                        throw BusinessRejection::forCode('finance.opening_not_submitted', 'only a submitted opening state can be approved');
                    }
                    if (trim((string) $locked->prepared_by) === $approver->actorId) {
                        throw AuthorizationDenied::forCode('finance.opening_not_independent', 'the approver must differ from the preparer');
                    }
                    if (OpeningState::query()->where('organization_id', $locked->organization_id)->where('status', OpeningState::STATUS_APPROVED)->exists()) {
                        throw BusinessRejection::forCode('finance.opening_second_approved', 'an approved opening state already exists for this organization');
                    }

                    $entries = OpeningEntry::query()->where('opening_state_id', $locked->id)->orderBy('source_ref')->get();
                    if ($entries->isEmpty()) {
                        throw BusinessRejection::forCode('finance.opening_empty', 'an opening state without entries cannot be approved');
                    }

                    /** @var FinancialPeriod|null $period */
                    $period = FinancialPeriod::query()->where('period_key', $locked->opening_period_key)->lockForUpdate()->first();
                    if ($period === null || $period->lifecycle_state !== FinanceLifecycle::PERIOD_OPEN) {
                        throw BusinessRejection::forCode('finance.opening_period', 'the opening period must exist and be open');
                    }

                    $digest = OpeningEntryContract::digestFor($locked);

                    // the preparer's posting authority materializes the facts; the approver's decision releases them
                    $preparer = new Actor(trim((string) $locked->prepared_by), 'Opening Preparer');
                    $obligationCount = 0;
                    $journalCount = 0;
                    foreach ($entries as $entry) {
                        $already = OpeningMaterialization::query()->where('opening_entry_id', $entry->id)->exists();
                        if ($already) {
                            continue;
                        }
                        if (in_array($entry->category, OpeningEntryContract::RECEIVABLE_CATEGORIES, true)) {
                            $posted = $this->obligations->post($preparer, $period, (string) $entry->student_id, 'opening-state', $entry->description, [
                                ['category' => $entry->category, 'amount' => (string) $entry->amount, 'source_ref' => 'opening/'.$entry->id],
                            ], 'opening-entry/'.$entry->id);
                            OpeningMaterialization::query()->create([
                                'id' => RandomIdentifier::new(),
                                'opening_entry_id' => $entry->id,
                                'instrument_type' => 'obligation',
                                'instrument_id' => $posted['obligation_id'],
                            ]);
                            $obligationCount++;
                        }
                        if ($entry->category === OpeningEntry::CATEGORY_CASH_POSITION) {
                            $posted = $this->journals->post($preparer, $period, 'other', $entry->id, 'opening cash position: '.$entry->description, [
                                ['account_id' => (string) $entry->asset_account_id, 'direction' => 'debit', 'amount' => (string) $entry->amount],
                                ['account_id' => (string) $entry->equity_account_id, 'direction' => 'credit', 'amount' => (string) $entry->amount],
                            ], 'opening-entry/'.$entry->id);
                            OpeningMaterialization::query()->create([
                                'id' => RandomIdentifier::new(),
                                'opening_entry_id' => $entry->id,
                                'instrument_type' => 'journal',
                                'instrument_id' => $posted['journal_id'],
                            ]);
                            $journalCount++;
                        }
                    }

                    $locked->forceFill([
                        'status' => OpeningState::STATUS_APPROVED,
                        'approved_by' => $approver->actorId,
                        'approved_at' => now(),
                        'approval_digest' => $digest,
                    ]);
                    $locked->save();
                    $event = $this->audit->record($approver->actorId, 'finance.opening.approve', 'opening_state', $locked->id, null, [
                        'organization_id' => $locked->organization_id,
                        'digest' => $digest,
                        'obligations' => $obligationCount,
                        'journals' => $journalCount,
                        'entries' => $entries->count(),
                    ]);

                    return ['opening_state_id' => $locked->id, 'approval_digest' => $digest, 'obligations' => $obligationCount, 'journals' => $journalCount, 'correlation_id' => $event->correlation_id];
                }),
            );
        } catch (AuthorizationDenied $denial) {
            $this->attemptedOperation->deniedByActor($denial, $approver, 'finance.opening.approve', 'opening_state', $state->id);
        }
    }

    private function require(Actor $actor): void
    {
        $outcome = $this->access->decide($actor, self::CAPABILITY, null);
        if (! $outcome->allowed) {
            throw AuthorizationDenied::forCode('finance.opening_approve_denied', $outcome->reason);
        }
    }
}
