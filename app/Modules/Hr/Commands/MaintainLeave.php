<?php

declare(strict_types=1);

namespace App\Modules\Hr\Commands;

use App\Modules\Audit\AttemptedOperation;
use App\Modules\Audit\AuditRecorder;
use App\Modules\Hr\Domain\EmploymentLifecycle;
use App\Modules\Hr\Domain\LeaveLifecycle;
use App\Modules\Hr\Models\Employment;
use App\Modules\Hr\Models\Leave;
use App\Support\Authorization\AccessDecision;
use App\Support\Authorization\Actor;
use App\Support\Errors\AuthorizationDenied;
use App\Support\Errors\BusinessRejection;
use App\Support\Idempotency\IdempotentExecution;
use App\Support\Identifiers\RandomIdentifier;
use Illuminate\Support\Facades\DB;

/**
 * Leave: one pending request per employment, decided by a different actor;
 * approved leave may not overlap another approved leave of the same
 * employment and every decision stays in history.
 */
final class MaintainLeave
{
    public const CAPABILITY_REQUEST = 'hr.leave_request';

    public const CAPABILITY_DECIDE = 'hr.leave_approve';

    public function __construct(
        private readonly AccessDecision $access,
        private readonly IdempotentExecution $idempotency,
        private readonly AuditRecorder $audit,
        private readonly AttemptedOperation $attemptedOperation,
    ) {}

    /** @return array{leave_id: string, correlation_id: string} */
    public function request(Actor $requester, Employment $employment, string $category, string $dateFrom, string $dateTo, string $reason, string $idempotencyKey): array
    {
        $payload = hash('sha256', implode('|', ['hr.leave.request', $employment->id, $category, $dateFrom, $dateTo, $reason, $requester->actorId]));

        try {
            return $this->idempotency->execute('hr.leave.request', $idempotencyKey, $payload,
                fn (): array => DB::transaction(function () use ($requester, $employment, $category, $dateFrom, $dateTo, $reason): array {
                    $this->require($requester, self::CAPABILITY_REQUEST);
                    if ($reason === '') {
                        throw BusinessRejection::forCode('hr.leave_reason', 'a leave request requires a reason');
                    }
                    if ($dateTo < $dateFrom) {
                        throw BusinessRejection::forCode('hr.leave_period', 'the leave period is inverted');
                    }

                    /** @var Employment $locked */
                    $locked = Employment::query()->whereKey($employment->id)->lockForUpdate()->firstOrFail();
                    if (! in_array($locked->lifecycle_state, [EmploymentLifecycle::STATE_ACTIVE, EmploymentLifecycle::STATE_ON_LEAVE], true)) {
                        throw BusinessRejection::forCode('hr.leave_employment_not_open', 'leave attaches only to an active or on-leave employment');
                    }

                    $leave = Leave::query()->create([
                        'id' => RandomIdentifier::new(),
                        'employment_id' => $locked->id,
                        'category' => $category,
                        'date_from' => $dateFrom,
                        'date_to' => $dateTo,
                        'reason' => $reason,
                        'lifecycle_state' => LeaveLifecycle::STATE_REQUESTED,
                        'requested_by' => $requester->actorId,
                    ]);
                    $event = $this->audit->record($requester->actorId, 'hr.leave.request', 'leave', $leave->id, null, ['employment_id' => $locked->id, 'category' => $category, 'date_from' => $dateFrom, 'date_to' => $dateTo]);

                    return ['leave_id' => $leave->id, 'correlation_id' => $event->correlation_id];
                }),
            );
        } catch (AuthorizationDenied $denial) {
            $this->attemptedOperation->deniedByActor($denial, $requester, 'hr.leave.request', 'leave', $employment->id);
        }
    }

    /** @return array{leave_id: string, lifecycle_state: string, correlation_id: string} */
    public function decide(Actor $decider, Leave $leave, bool $approve, string $idempotencyKey): array
    {
        $payload = hash('sha256', implode('|', ['hr.leave.decide', $leave->id, $approve ? 'approved' : 'rejected', $decider->actorId]));

        try {
            return $this->idempotency->execute('hr.leave.decide', $idempotencyKey, $payload,
                fn (): array => DB::transaction(function () use ($decider, $leave, $approve): array {
                    $this->require($decider, self::CAPABILITY_DECIDE);

                    /** @var Leave $locked */
                    $locked = Leave::query()->whereKey($leave->id)->lockForUpdate()->firstOrFail();
                    $toState = $approve ? LeaveLifecycle::STATE_APPROVED : LeaveLifecycle::STATE_REJECTED;
                    LeaveLifecycle::requireTransition($locked->lifecycle_state, $toState);
                    if (trim((string) $locked->requested_by) === $decider->actorId) {
                        throw AuthorizationDenied::forCode('hr.leave_not_independent', 'the decider must differ from the requester');
                    }
                    if ($approve) {
                        /** @var Employment $employment */
                        $employment = Employment::query()->whereKey($locked->employment_id)->lockForUpdate()->firstOrFail();
                        if (! in_array($employment->lifecycle_state, [EmploymentLifecycle::STATE_ACTIVE, EmploymentLifecycle::STATE_ON_LEAVE], true)) {
                            throw BusinessRejection::forCode('hr.leave_employment_not_open', 'leave can be approved only while the employment is open');
                        }
                        if ($this->overlaps($locked->employment_id, $locked->date_from, $locked->date_to)) {
                            throw BusinessRejection::forCode('hr.leave_overlap', 'approved leave periods may not overlap for the same employment');
                        }
                    }

                    $before = ['lifecycle_state' => $locked->lifecycle_state];
                    $locked->forceFill(['lifecycle_state' => $toState, 'decided_by' => $decider->actorId]);
                    $locked->save();
                    $event = $this->audit->record($decider->actorId, 'hr.leave.decide', 'leave', $locked->id, $before, ['lifecycle_state' => $toState]);

                    return ['leave_id' => $locked->id, 'lifecycle_state' => $toState, 'correlation_id' => $event->correlation_id];
                }),
            );
        } catch (AuthorizationDenied $denial) {
            $this->attemptedOperation->deniedByActor($denial, $decider, 'hr.leave.decide', 'leave', $leave->id);
        }
    }

    /** @return array{leave_id: string, lifecycle_state: string, correlation_id: string} */
    public function cancel(Actor $actor, Leave $leave, string $idempotencyKey): array
    {
        $payload = hash('sha256', implode('|', ['hr.leave.cancel', $leave->id, $actor->actorId]));

        try {
            return $this->idempotency->execute('hr.leave.cancel', $idempotencyKey, $payload,
                fn (): array => DB::transaction(function () use ($actor, $leave): array {
                    $this->require($actor, self::CAPABILITY_REQUEST);

                    /** @var Leave $locked */
                    $locked = Leave::query()->whereKey($leave->id)->lockForUpdate()->firstOrFail();
                    LeaveLifecycle::requireTransition($locked->lifecycle_state, LeaveLifecycle::STATE_CANCELLED);

                    $before = ['lifecycle_state' => $locked->lifecycle_state];
                    $locked->forceFill(['lifecycle_state' => LeaveLifecycle::STATE_CANCELLED]);
                    $locked->save();
                    $event = $this->audit->record($actor->actorId, 'hr.leave.cancel', 'leave', $locked->id, $before, ['lifecycle_state' => LeaveLifecycle::STATE_CANCELLED]);

                    return ['leave_id' => $locked->id, 'lifecycle_state' => LeaveLifecycle::STATE_CANCELLED, 'correlation_id' => $event->correlation_id];
                }),
            );
        } catch (AuthorizationDenied $denial) {
            $this->attemptedOperation->deniedByActor($denial, $actor, 'hr.leave.cancel', 'leave', $leave->id);
        }
    }

    private function overlaps(string $employmentId, string $from, string $to): bool
    {
        return Leave::query()
            ->where('employment_id', $employmentId)
            ->where('lifecycle_state', LeaveLifecycle::STATE_APPROVED)
            ->where('date_from', '<=', $to)
            ->where('date_to', '>=', $from)
            ->exists();
    }

    private function require(Actor $actor, string $capability): void
    {
        $outcome = $this->access->decide($actor, $capability, null);
        if (! $outcome->allowed) {
            throw AuthorizationDenied::forCode('hr.leave_denied', $outcome->reason);
        }
    }
}
