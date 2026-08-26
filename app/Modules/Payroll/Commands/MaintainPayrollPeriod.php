<?php

declare(strict_types=1);

namespace App\Modules\Payroll\Commands;

use App\Modules\Audit\AttemptedOperation;
use App\Modules\Audit\AuditRecorder;
use App\Modules\Payroll\Domain\PayrollLifecycle;
use App\Modules\Payroll\Models\PayrollCalculation;
use App\Modules\Payroll\Models\PayrollPeriod;
use App\Support\Authorization\AccessDecision;
use App\Support\Authorization\Actor;
use App\Support\Errors\AuthorizationDenied;
use App\Support\Errors\BusinessRejection;
use App\Support\Idempotency\IdempotentExecution;
use App\Support\Identifiers\RandomIdentifier;
use Illuminate\Support\Facades\DB;

/**
 * Payroll periods: one window per key, controlled closing. Closing is
 * rejected while held (contract-silent) calculations remain — they must be
 * resolved by HR/Finance review first, never skipped.
 */
final class MaintainPayrollPeriod
{
    public const CAPABILITY = 'payroll.period';

    public function __construct(
        private readonly AccessDecision $access,
        private readonly IdempotentExecution $idempotency,
        private readonly AuditRecorder $audit,
        private readonly AttemptedOperation $attemptedOperation,
    ) {}

    /** @return array{period_id: string, correlation_id: string} */
    public function open(Actor $actor, string $periodKey, string $dateFrom, string $dateTo, string $idempotencyKey): array
    {
        $payload = hash('sha256', implode('|', ['payroll.period.open', $periodKey, $dateFrom, $dateTo, $actor->actorId]));

        try {
            return $this->idempotency->execute('payroll.period.open', $idempotencyKey, $payload,
                fn (): array => DB::transaction(function () use ($actor, $periodKey, $dateFrom, $dateTo): array {
                    $this->require($actor);
                    if ($dateTo < $dateFrom) {
                        throw BusinessRejection::forCode('payroll.period_window', 'the period window is inverted');
                    }
                    if (PayrollPeriod::query()->where('period_key', $periodKey)->exists()) {
                        throw BusinessRejection::forCode('payroll.period_key_exists', 'this payroll period key already exists');
                    }

                    $period = PayrollPeriod::query()->create([
                        'id' => RandomIdentifier::new(),
                        'period_key' => $periodKey,
                        'date_from' => $dateFrom,
                        'date_to' => $dateTo,
                        'lifecycle_state' => PayrollLifecycle::PERIOD_OPEN,
                    ]);
                    $event = $this->audit->record($actor->actorId, 'payroll.period.open', 'payroll_period', $period->id, null, ['period_key' => $periodKey]);

                    return ['period_id' => $period->id, 'correlation_id' => $event->correlation_id];
                }),
            );
        } catch (AuthorizationDenied $denial) {
            $this->attemptedOperation->deniedByActor($denial, $actor, 'payroll.period.open', 'payroll_period', $periodKey);
        }
    }

    /** @return array{period_id: string, lifecycle_state: string, correlation_id: string} */
    public function close(Actor $actor, PayrollPeriod $period, string $idempotencyKey): array
    {
        $payload = hash('sha256', implode('|', ['payroll.period.close', $period->id, $actor->actorId]));

        try {
            return $this->idempotency->execute('payroll.period.close', $idempotencyKey, $payload,
                fn (): array => DB::transaction(function () use ($actor, $period): array {
                    $this->require($actor);

                    /** @var PayrollPeriod $locked */
                    $locked = PayrollPeriod::query()->whereKey($period->id)->lockForUpdate()->firstOrFail();
                    PayrollLifecycle::requirePeriodTransition($locked->lifecycle_state, PayrollLifecycle::PERIOD_CLOSED);

                    $held = PayrollCalculation::query()->where('period_id', $locked->id)->where('lifecycle_state', PayrollLifecycle::CALC_HELD)->count();
                    if ($held > 0) {
                        throw BusinessRejection::forCode('payroll.period_close_held', sprintf('%d held (contract-silent) calculations must be resolved before closure', $held));
                    }

                    $before = ['lifecycle_state' => $locked->lifecycle_state];
                    $locked->forceFill(['lifecycle_state' => PayrollLifecycle::PERIOD_CLOSED]);
                    $locked->save();
                    $event = $this->audit->record($actor->actorId, 'payroll.period.close', 'payroll_period', $locked->id, $before, ['lifecycle_state' => PayrollLifecycle::PERIOD_CLOSED]);

                    return ['period_id' => $locked->id, 'lifecycle_state' => PayrollLifecycle::PERIOD_CLOSED, 'correlation_id' => $event->correlation_id];
                }),
            );
        } catch (AuthorizationDenied $denial) {
            $this->attemptedOperation->deniedByActor($denial, $actor, 'payroll.period.close', 'payroll_period', $period->id);
        }
    }

    private function require(Actor $actor): void
    {
        $outcome = $this->access->decide($actor, self::CAPABILITY, null);
        if (! $outcome->allowed) {
            throw AuthorizationDenied::forCode('payroll.period_denied', $outcome->reason);
        }
    }
}
