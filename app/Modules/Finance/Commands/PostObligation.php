<?php

declare(strict_types=1);

namespace App\Modules\Finance\Commands;

use App\Modules\Academic\Models\Enrollment;
use App\Modules\Academic\Models\Offering;
use App\Modules\Audit\AttemptedOperation;
use App\Modules\Audit\AuditRecorder;
use App\Modules\Finance\Domain\FinanceLifecycle;
use App\Modules\Finance\Models\FinancialPeriod;
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
 * Approved charge: posts the obligation and its atomic lines in one
 * transaction — the lines must sum exactly to the obligation amount. The
 * obligation is an immutable source fact; balances are derived, never
 * stored.
 */
final class PostObligation
{
    public const CAPABILITY = 'finance.obligation';

    public function __construct(
        private readonly AccessDecision $access,
        private readonly IdempotentExecution $idempotency,
        private readonly AuditRecorder $audit,
        private readonly AttemptedOperation $attemptedOperation,
    ) {}

    /**
     * @param  list<array{category: string, amount: string, source_ref: string}>  $lines
     * @return array{obligation_id: string, correlation_id: string}
     */
    public function post(Actor $actor, FinancialPeriod $period, string $studentId, string $source, string $reason, array $lines, string $idempotencyKey, ?string $offeringId = null): array
    {
        $payload = hash('sha256', implode('|', ['finance.obligation.post', $period->id, $studentId, $source, $reason, json_encode($lines), $offeringId ?? '', $actor->actorId]));

        try {
            return $this->idempotency->execute('finance.obligation.post', $idempotencyKey, $payload,
                fn (): array => DB::transaction(function () use ($actor, $period, $studentId, $source, $reason, $lines, $offeringId): array {
                    $this->require($actor);
                    if ($lines === [] || $reason === '') {
                        throw BusinessRejection::forCode('finance.obligation_lines', 'an obligation requires lines and a reason');
                    }

                    /** @var FinancialPeriod $lockedPeriod */
                    $lockedPeriod = FinancialPeriod::query()->whereKey($period->id)->lockForUpdate()->firstOrFail();
                    if ($lockedPeriod->lifecycle_state !== FinanceLifecycle::PERIOD_OPEN) {
                        throw BusinessRejection::forCode('finance.period_not_open', 'obligations post only to an open financial period');
                    }

                    $total = '0.00';
                    foreach ($lines as $line) {
                        if (! is_numeric($line['amount']) || (float) $line['amount'] <= 0) {
                            throw BusinessRejection::forCode('finance.obligation_line_amount', 'every line amount must be a positive number');
                        }
                        $total = bcadd($total, (string) $line['amount'], 2);
                    }

                    if ($offeringId !== null && $offeringId !== '') {
                        $this->assertOfferingLinkedToActiveEnrollment($offeringId, $studentId);
                    }

                    $obligation = Obligation::query()->create([
                        'id' => RandomIdentifier::new(),
                        'period_id' => $lockedPeriod->id,
                        'student_id' => $studentId,
                        'source' => $source,
                        'original_amount' => $total,
                        'reason' => $reason,
                        'posted_by' => $actor->actorId,
                        'offering_id' => $offeringId !== null && $offeringId !== '' ? $offeringId : null,
                    ]);
                    foreach ($lines as $line) {
                        ObligationLine::query()->create([
                            'id' => RandomIdentifier::new(),
                            'obligation_id' => $obligation->id,
                            'category' => $line['category'],
                            'amount' => $line['amount'],
                            'source_ref' => $line['source_ref'],
                        ]);
                    }
                    $event = $this->audit->record($actor->actorId, 'finance.obligation.post', 'obligation', $obligation->id, null, [
                        'student_id' => $studentId, 'original_amount' => $total, 'lines' => count($lines), 'offering_id' => $obligation->offering_id,
                    ]);

                    return ['obligation_id' => $obligation->id, 'correlation_id' => $event->correlation_id];
                }),
            );
        } catch (AuthorizationDenied $denial) {
            $this->attemptedOperation->deniedByActor($denial, $actor, 'finance.obligation.post', 'obligation', $studentId);
        }
    }

    private function assertOfferingLinkedToActiveEnrollment(string $offeringId, string $studentId): void
    {
        /** @var Offering|null $offering */
        $offering = Offering::query()->find($offeringId);
        if ($offering === null || $offering->lifecycle_state === Offering::STATE_CANCELLED) {
            throw BusinessRejection::forCode('finance.obligation_offering_invalid', 'an obligation offering must be a known non-cancelled academic offering');
        }
        // A live membership request/active/frozen is the offering packaging
        // context Finance attributes a charge to. Requested is included so a
        // tuition obligation can be posted before activation, when the
        // financial gate is evaluated. Academic never derives the amount.
        if (! Enrollment::query()
            ->where('student_id', $studentId)
            ->where('offering_id', $offeringId)
            ->whereIn('lifecycle_state', ['requested', 'active', 'frozen'])
            ->exists()) {
            throw BusinessRejection::forCode('finance.obligation_offering_enrollment_mismatch', 'the obligation offering must belong to a live enrollment of the student');
        }
    }

    private function require(Actor $actor): void
    {
        $outcome = $this->access->decide($actor, self::CAPABILITY, null);
        if (! $outcome->allowed) {
            throw AuthorizationDenied::forCode('finance.obligation_denied', $outcome->reason);
        }
    }
}
