<?php

declare(strict_types=1);

namespace App\Modules\Finance\Commands;

use App\Modules\Audit\AttemptedOperation;
use App\Modules\Audit\AuditRecorder;
use App\Modules\Finance\Models\FundAllocation;
use App\Modules\Finance\Models\FundingSource;
use App\Modules\Finance\Models\Obligation;
use App\Modules\Finance\Models\ObligationLine;
use App\Support\Authorization\AccessDecision;
use App\Support\Authorization\Actor;
use App\Support\Errors\AuthorizationDenied;
use App\Support\Errors\BusinessRejection;
use App\Support\Idempotency\IdempotentExecution;
use App\Support\Identifiers\RandomIdentifier;
use Illuminate\Support\Facades\DB;

/**
 * Funding: an immutable funding agreement establishes a pool and its
 * restriction (never reclassified — BR-FUND-002); allocations apply fund
 * money to student obligation lines of the permitted use only, never
 * exceed the committed pool, and commit under a fund row lock. Utilization
 * is derived from allocations, never stored.
 */
final class AllocateFunds
{
    public const CAPABILITY_ESTABLISH = 'finance.fund';

    public const CAPABILITY_ALLOCATE = 'finance.fund_allocate';

    public function __construct(
        private readonly AccessDecision $access,
        private readonly IdempotentExecution $idempotency,
        private readonly AuditRecorder $audit,
        private readonly AttemptedOperation $attemptedOperation,
        private readonly AllocatePayment $allocations,
    ) {}

    /** @return array{fund_id: string, correlation_id: string} */
    public function establish(Actor $actor, string $name, string $agreementRef, string $committedAmount, ?string $restrictedCategory, ?string $restrictionNote, string $idempotencyKey): array
    {
        $payload = hash('sha256', implode('|', ['finance.fund.establish', $name, $agreementRef, $committedAmount, (string) $restrictedCategory, $actor->actorId]));

        try {
            return $this->idempotency->execute('finance.fund.establish', $idempotencyKey, $payload,
                fn (): array => DB::transaction(function () use ($actor, $name, $agreementRef, $committedAmount, $restrictedCategory, $restrictionNote): array {
                    $this->require($actor, self::CAPABILITY_ESTABLISH);
                    if ($name === '' || $agreementRef === '') {
                        throw BusinessRejection::forCode('finance.fund_terms', 'a funding source requires a name and its agreement reference');
                    }
                    if (! is_numeric($committedAmount) || (float) $committedAmount <= 0) {
                        throw BusinessRejection::forCode('finance.fund_committed', 'the committed pool must be a positive number');
                    }
                    if ($restrictedCategory !== null && $restrictedCategory !== '' && ($restrictionNote === null || $restrictionNote === '')) {
                        throw BusinessRejection::forCode('finance.fund_restriction_note', 'a restricted fund requires its restriction note');
                    }

                    $fund = FundingSource::query()->create([
                        'id' => RandomIdentifier::new(),
                        'name' => $name,
                        'agreement_ref' => $agreementRef,
                        'committed_amount' => $committedAmount,
                        'restricted_category' => ($restrictedCategory === '' ? null : $restrictedCategory),
                        'restriction_note' => $restrictionNote,
                        'established_by' => $actor->actorId,
                    ]);
                    $event = $this->audit->record($actor->actorId, 'finance.fund.establish', 'funding_source', $fund->id, null, [
                        'agreement_ref' => $agreementRef, 'committed_amount' => $committedAmount, 'restricted_category' => $fund->restricted_category,
                    ]);

                    return ['fund_id' => $fund->id, 'correlation_id' => $event->correlation_id];
                }),
            );
        } catch (AuthorizationDenied $denial) {
            $this->attemptedOperation->deniedByActor($denial, $actor, 'finance.fund.establish', 'funding_source', $name);
        }
    }

    /** @return array{allocation_id: string, correlation_id: string} */
    public function allocate(Actor $actor, FundingSource $fund, ObligationLine $line, string $amount, string $reason, string $idempotencyKey): array
    {
        $payload = hash('sha256', implode('|', ['finance.fund.allocate', $fund->id, $line->id, $amount, $reason, $actor->actorId]));

        try {
            return $this->idempotency->execute('finance.fund.allocate', $idempotencyKey, $payload,
                fn (): array => DB::transaction(function () use ($actor, $fund, $line, $amount, $reason): array {
                    $this->require($actor, self::CAPABILITY_ALLOCATE);
                    if ($reason === '') {
                        throw BusinessRejection::forCode('finance.fund_allocation_reason', 'a fund allocation requires a reason');
                    }
                    if (! is_numeric($amount) || (float) $amount <= 0) {
                        throw BusinessRejection::forCode('finance.fund_allocation_amount', 'the fund allocation amount must be a positive number');
                    }

                    /** @var FundingSource $lockedFund */
                    $lockedFund = FundingSource::query()->whereKey($fund->id)->lockForUpdate()->firstOrFail();
                    $restriction = trim((string) $lockedFund->restricted_category);
                    if ($restriction !== '' && $restriction !== trim((string) $line->category)) {
                        throw BusinessRejection::forCode('finance.fund_restriction', sprintf('the fund is restricted to %s; the obligation line is %s', $restriction, $line->category));
                    }

                    $utilized = FundAllocation::query()->where('fund_id', $lockedFund->id)->sum('amount');
                    $available = bcsub((string) $lockedFund->committed_amount, (string) $utilized, 2);
                    if (bccomp($amount, $available, 2) === 1) {
                        throw BusinessRejection::forCode('finance.fund_exhausted', sprintf('the allocation exceeds the unutilized pool remainder %s', $available));
                    }

                    /** @var Obligation $obligation */
                    $obligation = Obligation::query()->whereKey($line->obligation_id)->lockForUpdate()->firstOrFail();
                    $lineRemaining = bcsub((string) $line->amount, (string) FundAllocation::query()->where('obligation_line_id', $line->id)->sum('amount'), 2);
                    if (bccomp($amount, $lineRemaining, 2) === 1) {
                        throw BusinessRejection::forCode('finance.fund_exceeds_line', sprintf('the allocation exceeds the uncovered line remainder %s', $lineRemaining));
                    }
                    if (bccomp($amount, $this->allocations->obligationRemaining($obligation), 2) === 1) {
                        throw BusinessRejection::forCode('finance.fund_exceeds_obligation', 'the allocation exceeds the uncovered obligation remainder');
                    }

                    $allocation = FundAllocation::query()->create([
                        'id' => RandomIdentifier::new(),
                        'fund_id' => $lockedFund->id,
                        'obligation_line_id' => $line->id,
                        'amount' => $amount,
                        'reason' => $reason,
                        'allocated_by' => $actor->actorId,
                    ]);
                    $event = $this->audit->record($actor->actorId, 'finance.fund.allocate', 'fund_allocation', $allocation->id, null, [
                        'fund_id' => $lockedFund->id, 'obligation_line_id' => $line->id, 'amount' => $amount,
                    ]);

                    return ['allocation_id' => $allocation->id, 'correlation_id' => $event->correlation_id];
                }),
            );
        } catch (AuthorizationDenied $denial) {
            $this->attemptedOperation->deniedByActor($denial, $actor, 'finance.fund.allocate', 'fund_allocation', $fund->id);
        }
    }

    private function require(Actor $actor, string $capability): void
    {
        $outcome = $this->access->decide($actor, $capability, null);
        if (! $outcome->allowed) {
            throw AuthorizationDenied::forCode('finance.fund_denied', $outcome->reason);
        }
    }
}
