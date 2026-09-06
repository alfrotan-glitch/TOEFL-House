<?php

declare(strict_types=1);

namespace App\Modules\Finance\Commands;

use App\Modules\Audit\AttemptedOperation;
use App\Modules\Audit\AuditRecorder;
use App\Modules\Finance\Domain\FinanceLifecycle;
use App\Modules\Finance\Models\FinancialPeriod;
use App\Modules\Payroll\Models\PayrollPeriod;
use App\Support\Authorization\AccessDecision;
use App\Support\Authorization\Actor;
use App\Support\Errors\AuthorizationDenied;
use App\Support\Errors\BusinessRejection;
use App\Support\Idempotency\IdempotentExecution;
use App\Support\Identifiers\RandomIdentifier;
use Illuminate\Support\Facades\DB;

/**
 * Financial periods: one window per key; closing is a controlled act that
 * coordinates with payroll periods through an explicit status check — an
 * overlapping open payroll period creates an exception, never a silent
 * overwrite. Closed periods never reopen.
 */
final class MaintainFinancialPeriod
{
    public const CAPABILITY = 'finance.period';

    public function __construct(
        private readonly AccessDecision $access,
        private readonly IdempotentExecution $idempotency,
        private readonly AuditRecorder $audit,
        private readonly AttemptedOperation $attemptedOperation,
    ) {}

    /** @return array{period_id: string, correlation_id: string} */
    public function open(Actor $actor, string $periodKey, string $dateFrom, string $dateTo, string $idempotencyKey): array
    {
        $payload = hash('sha256', implode('|', ['finance.period.open', $periodKey, $dateFrom, $dateTo, $actor->actorId]));

        try {
            return $this->idempotency->execute('finance.period.open', $idempotencyKey, $payload,
                fn (): array => DB::transaction(function () use ($actor, $periodKey, $dateFrom, $dateTo): array {
                    $this->require($actor);
                    if ($dateTo < $dateFrom) {
                        throw BusinessRejection::forCode('finance.period_window', 'the period window is inverted');
                    }
                    if (FinancialPeriod::query()->where('period_key', $periodKey)->exists()) {
                        throw BusinessRejection::forCode('finance.period_key_exists', 'this financial period key already exists');
                    }

                    $period = FinancialPeriod::query()->create([
                        'id' => RandomIdentifier::new(),
                        'period_key' => $periodKey,
                        'date_from' => $dateFrom,
                        'date_to' => $dateTo,
                        'lifecycle_state' => FinanceLifecycle::PERIOD_OPEN,
                    ]);
                    $event = $this->audit->record($actor->actorId, 'finance.period.open', 'financial_period', $period->id, null, ['period_key' => $periodKey]);

                    return ['period_id' => $period->id, 'correlation_id' => $event->correlation_id];
                }),
            );
        } catch (AuthorizationDenied $denial) {
            $this->attemptedOperation->deniedByActor($denial, $actor, 'finance.period.open', 'financial_period', $periodKey);
        }
    }

    /** @return array{period_id: string, lifecycle_state: string, correlation_id: string} */
    public function close(Actor $actor, FinancialPeriod $period, string $idempotencyKey): array
    {
        $payload = hash('sha256', implode('|', ['finance.period.close', $period->id, $actor->actorId]));

        try {
            return $this->idempotency->execute('finance.period.close', $idempotencyKey, $payload,
                fn (): array => DB::transaction(function () use ($actor, $period): array {
                    $this->require($actor);

                    /** @var FinancialPeriod $locked */
                    $locked = FinancialPeriod::query()->whereKey($period->id)->lockForUpdate()->firstOrFail();
                    FinanceLifecycle::requirePeriodTransition($locked->lifecycle_state, FinanceLifecycle::PERIOD_CLOSED);

                    $openPayroll = PayrollPeriod::query()
                        ->where('lifecycle_state', '!=', 'closed')
                        ->where('date_from', '<=', $locked->date_to)
                        ->where('date_to', '>=', $locked->date_from)
                        ->count();
                    if ($openPayroll > 0) {
                        throw BusinessRejection::forCode('finance.period_payroll_open', sprintf('%d overlapping payroll periods are still open', $openPayroll));
                    }

                    $before = ['lifecycle_state' => $locked->lifecycle_state];
                    $locked->forceFill(['lifecycle_state' => FinanceLifecycle::PERIOD_CLOSED, 'closed_by' => $actor->actorId]);
                    $locked->save();
                    $event = $this->audit->record($actor->actorId, 'finance.period.close', 'financial_period', $locked->id, $before, ['lifecycle_state' => FinanceLifecycle::PERIOD_CLOSED]);

                    return ['period_id' => $locked->id, 'lifecycle_state' => FinanceLifecycle::PERIOD_CLOSED, 'correlation_id' => $event->correlation_id];
                }),
            );
        } catch (AuthorizationDenied $denial) {
            $this->attemptedOperation->deniedByActor($denial, $actor, 'finance.period.close', 'financial_period', $period->id);
        }
    }

    private function require(Actor $actor): void
    {
        $outcome = $this->access->decide($actor, self::CAPABILITY, null);
        if (! $outcome->allowed) {
            throw AuthorizationDenied::forCode('finance.period_denied', $outcome->reason);
        }
    }
}
