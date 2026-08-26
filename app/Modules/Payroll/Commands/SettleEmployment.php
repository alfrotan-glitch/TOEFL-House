<?php

declare(strict_types=1);

namespace App\Modules\Payroll\Commands;

use App\Modules\Audit\AttemptedOperation;
use App\Modules\Audit\AuditRecorder;
use App\Modules\Hr\Domain\EmploymentLifecycle;
use App\Modules\Hr\Models\Employment;
use App\Modules\Payroll\Models\FinalSettlement;
use App\Modules\Payroll\Models\PayrollClearance;
use App\Support\Authorization\AccessDecision;
use App\Support\Authorization\Actor;
use App\Support\Errors\AuthorizationDenied;
use App\Support\Errors\BusinessRejection;
use App\Support\Idempotency\IdempotentExecution;
use App\Support\Identifiers\RandomIdentifier;
use Illuminate\Support\Facades\DB;

/**
 * Termination settlement: HR and Finance each clear, then a distinct
 * approver records the immutable final settlement. The settlement basis is
 * declared evidence — the system never invents the amount.
 */
final class SettleEmployment
{
    public const CAPABILITY_CLEAR_HR = 'payroll.clear_hr';

    public const CAPABILITY_CLEAR_FINANCE = 'payroll.clear_finance';

    public const CAPABILITY_SETTLE = 'payroll.settle';

    public const CAPABILITY_SETTLE_APPROVE = 'payroll.settle_approve';

    public function __construct(
        private readonly AccessDecision $access,
        private readonly IdempotentExecution $idempotency,
        private readonly AuditRecorder $audit,
        private readonly AttemptedOperation $attemptedOperation,
    ) {}

    /** @return array{clearance_id: string, correlation_id: string} */
    public function clear(Actor $actor, Employment $employment, string $domain, string $note, string $idempotencyKey): array
    {
        $payload = hash('sha256', implode('|', ['payroll.clearance', $employment->id, $domain, $actor->actorId]));

        try {
            return $this->idempotency->execute('payroll.clearance', $idempotencyKey, $payload,
                fn (): array => DB::transaction(function () use ($actor, $employment, $domain, $note): array {
                    $capability = $domain === 'hr' ? self::CAPABILITY_CLEAR_HR : self::CAPABILITY_CLEAR_FINANCE;
                    $this->require($actor, $capability);
                    if (! in_array($domain, ['hr', 'finance'], true)) {
                        throw BusinessRejection::forCode('payroll.clearance_domain', 'clearance domains are hr and finance');
                    }
                    if ($note === '') {
                        throw BusinessRejection::forCode('payroll.clearance_note', 'a clearance requires its note');
                    }

                    /** @var Employment $locked */
                    $locked = Employment::query()->whereKey($employment->id)->lockForUpdate()->firstOrFail();
                    if (PayrollClearance::query()->where('employment_id', $locked->id)->where('domain', $domain)->exists()) {
                        throw BusinessRejection::forCode('payroll.clearance_exists', 'this domain already cleared this employment');
                    }

                    $clearance = PayrollClearance::query()->create([
                        'id' => RandomIdentifier::new(),
                        'employment_id' => $locked->id,
                        'domain' => $domain,
                        'note' => $note,
                        'cleared_by' => $actor->actorId,
                    ]);
                    $event = $this->audit->record($actor->actorId, 'payroll.clearance', 'payroll_clearance', $clearance->id, null, [
                        'employment_id' => $locked->id, 'domain' => $domain,
                    ]);

                    return ['clearance_id' => $clearance->id, 'correlation_id' => $event->correlation_id];
                }),
            );
        } catch (AuthorizationDenied $denial) {
            $this->attemptedOperation->deniedByActor($denial, $actor, 'payroll.clearance', 'payroll_clearance', $employment->id);
        }
    }

    /** @return array{settlement_id: string, correlation_id: string} */
    public function settle(Actor $preparer, Actor $approver, Employment $employment, string $amount, string $basis, string $idempotencyKey): array
    {
        $payload = hash('sha256', implode('|', ['payroll.settlement', $employment->id, $amount, $basis, $preparer->actorId, $approver->actorId]));

        try {
            return $this->idempotency->execute('payroll.settlement', $idempotencyKey, $payload,
                fn (): array => DB::transaction(function () use ($preparer, $approver, $employment, $amount, $basis): array {
                    $this->require($preparer, self::CAPABILITY_SETTLE);
                    $this->require($approver, self::CAPABILITY_SETTLE_APPROVE);
                    if ($preparer->actorId === $approver->actorId) {
                        throw AuthorizationDenied::forCode('payroll.settlement_not_independent', 'settlement preparation and approval need distinct actors');
                    }
                    if ($basis === '') {
                        throw BusinessRejection::forCode('payroll.settlement_basis', 'a settlement requires its basis evidence');
                    }
                    if (! is_numeric($amount) || (float) $amount < 0) {
                        throw BusinessRejection::forCode('payroll.settlement_amount', 'the settlement amount must be a non-negative number');
                    }

                    /** @var Employment $locked */
                    $locked = Employment::query()->whereKey($employment->id)->lockForUpdate()->firstOrFail();
                    if ($locked->lifecycle_state !== EmploymentLifecycle::STATE_TERMINATED) {
                        throw BusinessRejection::forCode('payroll.settlement_requires_termination', 'a final settlement requires a terminated employment');
                    }
                    if (trim((string) $locked->person_id) === $preparer->actorId || trim((string) $locked->person_id) === $approver->actorId) {
                        throw AuthorizationDenied::forCode('payroll.beneficiary', 'the beneficiary may never take part in their own settlement');
                    }
                    foreach (['hr', 'finance'] as $domain) {
                        if (! PayrollClearance::query()->where('employment_id', $locked->id)->where('domain', $domain)->exists()) {
                            throw BusinessRejection::forCode('payroll.settlement_requires_clearance', sprintf('the %s clearance is missing', $domain));
                        }
                    }
                    if (FinalSettlement::query()->where('employment_id', $locked->id)->exists()) {
                        throw BusinessRejection::forCode('payroll.settlement_exists', 'this employment is already settled');
                    }

                    $settlement = FinalSettlement::query()->create([
                        'id' => RandomIdentifier::new(),
                        'employment_id' => $locked->id,
                        'amount' => $amount,
                        'basis' => $basis,
                        'prepared_by' => $preparer->actorId,
                        'approved_by' => $approver->actorId,
                    ]);
                    $event = $this->audit->record($approver->actorId, 'payroll.settlement', 'final_settlement', $settlement->id, null, [
                        'employment_id' => $locked->id, 'amount' => $amount,
                    ]);

                    return ['settlement_id' => $settlement->id, 'correlation_id' => $event->correlation_id];
                }),
            );
        } catch (AuthorizationDenied $denial) {
            $this->attemptedOperation->deniedByActor($denial, $preparer, 'payroll.settlement', 'final_settlement', $employment->id);
        }
    }

    private function require(Actor $actor, string $capability): void
    {
        $outcome = $this->access->decide($actor, $capability, null);
        if (! $outcome->allowed) {
            throw AuthorizationDenied::forCode('payroll.settle_denied', $outcome->reason);
        }
    }
}
