<?php

declare(strict_types=1);

namespace App\Modules\Finance\Commands;

use App\Modules\Audit\AttemptedOperation;
use App\Modules\Audit\AuditRecorder;
use App\Modules\Finance\Domain\FinanceLifecycle;
use App\Modules\Finance\Models\FinancialPeriod;
use App\Modules\Finance\Models\Reconciliation;
use App\Support\Authorization\AccessDecision;
use App\Support\Authorization\Actor;
use App\Support\Errors\AuthorizationDenied;
use App\Support\Errors\BusinessRejection;
use App\Support\Idempotency\IdempotentExecution;
use App\Support\Identifiers\RandomIdentifier;
use Illuminate\Support\Facades\DB;

/**
 * Reconciliation owns comparison and variance evidence, never an
 * alternate cash truth: one observation per period and subject, locked on
 * approval by a different actor.
 */
final class RecordReconciliation
{
    public const CAPABILITY_OBSERVE = 'finance.reconcile';

    public const CAPABILITY_APPROVE = 'finance.reconcile_approve';

    public function __construct(
        private readonly AccessDecision $access,
        private readonly IdempotentExecution $idempotency,
        private readonly AuditRecorder $audit,
        private readonly AttemptedOperation $attemptedOperation,
    ) {}

    /** @return array{reconciliation_id: string, correlation_id: string} */
    public function observe(Actor $observer, FinancialPeriod $period, string $subject, string $expected, string $observed, ?string $explanation, string $idempotencyKey): array
    {
        $payload = hash('sha256', implode('|', ['finance.reconciliation.observe', $period->id, $subject, $expected, $observed, $observer->actorId]));

        try {
            return $this->idempotency->execute('finance.reconciliation.observe', $idempotencyKey, $payload,
                fn (): array => DB::transaction(function () use ($observer, $period, $subject, $expected, $observed, $explanation): array {
                    $this->require($observer, self::CAPABILITY_OBSERVE);
                    if (! is_numeric($expected) || ! is_numeric($observed)) {
                        throw BusinessRejection::forCode('finance.reconciliation_amounts', 'expected and observed values must be numeric');
                    }
                    if (((float) $observed - (float) $expected) != 0.0 && ($explanation === null || $explanation === '')) {
                        throw BusinessRejection::forCode('finance.reconciliation_explanation', 'a variance requires an explanation');
                    }

                    /** @var FinancialPeriod $lockedPeriod */
                    $lockedPeriod = FinancialPeriod::query()->whereKey($period->id)->lockForUpdate()->firstOrFail();
                    if (Reconciliation::query()->where('period_id', $lockedPeriod->id)->where('subject', $subject)->exists()) {
                        throw BusinessRejection::forCode('finance.reconciliation_exists', 'this period and subject already has a recorded observation');
                    }

                    $variance = bcsub((string) $observed, (string) $expected, 2);
                    $reconciliation = Reconciliation::query()->create([
                        'id' => RandomIdentifier::new(),
                        'period_id' => $lockedPeriod->id,
                        'subject' => $subject,
                        'expected' => $expected,
                        'observed' => $observed,
                        'variance' => $variance,
                        'explanation' => $explanation,
                        'lifecycle_state' => FinanceLifecycle::RECON_DRAFT,
                        'observed_by' => $observer->actorId,
                    ]);
                    $event = $this->audit->record($observer->actorId, 'finance.reconciliation.observe', 'reconciliation', $reconciliation->id, null, [
                        'period_id' => $lockedPeriod->id, 'subject' => $subject, 'variance' => $variance,
                    ]);

                    return ['reconciliation_id' => $reconciliation->id, 'correlation_id' => $event->correlation_id];
                }),
            );
        } catch (AuthorizationDenied $denial) {
            $this->attemptedOperation->deniedByActor($denial, $observer, 'finance.reconciliation.observe', 'reconciliation', $subject);
        }
    }

    /** @return array{reconciliation_id: string, lifecycle_state: string, correlation_id: string} */
    public function approve(Actor $approver, Reconciliation $reconciliation, string $idempotencyKey): array
    {
        $payload = hash('sha256', implode('|', ['finance.reconciliation.approve', $reconciliation->id, $approver->actorId]));

        try {
            return $this->idempotency->execute('finance.reconciliation.approve', $idempotencyKey, $payload,
                fn (): array => DB::transaction(function () use ($approver, $reconciliation): array {
                    $this->require($approver, self::CAPABILITY_APPROVE);

                    /** @var Reconciliation $locked */
                    $locked = Reconciliation::query()->whereKey($reconciliation->id)->lockForUpdate()->firstOrFail();
                    FinanceLifecycle::requireReconciliationTransition($locked->lifecycle_state, FinanceLifecycle::RECON_APPROVED);
                    if (trim((string) $locked->observed_by) === $approver->actorId) {
                        throw AuthorizationDenied::forCode('finance.reconciliation_not_independent', 'the approver must differ from the observer');
                    }

                    $before = ['lifecycle_state' => $locked->lifecycle_state];
                    $locked->forceFill(['lifecycle_state' => FinanceLifecycle::RECON_APPROVED, 'approved_by' => $approver->actorId]);
                    $locked->save();
                    $event = $this->audit->record($approver->actorId, 'finance.reconciliation.approve', 'reconciliation', $locked->id, $before, ['lifecycle_state' => FinanceLifecycle::RECON_APPROVED]);

                    return ['reconciliation_id' => $locked->id, 'lifecycle_state' => FinanceLifecycle::RECON_APPROVED, 'correlation_id' => $event->correlation_id];
                }),
            );
        } catch (AuthorizationDenied $denial) {
            $this->attemptedOperation->deniedByActor($denial, $approver, 'finance.reconciliation.approve', 'reconciliation', $reconciliation->id);
        }
    }

    private function require(Actor $actor, string $capability): void
    {
        $outcome = $this->access->decide($actor, $capability, null);
        if (! $outcome->allowed) {
            throw AuthorizationDenied::forCode('finance.reconcile_denied', $outcome->reason);
        }
    }
}
