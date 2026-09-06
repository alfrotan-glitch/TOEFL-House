<?php

declare(strict_types=1);

namespace App\Modules\Hr\Commands;

use App\Modules\Access\Commands\TransitionPositionAssignment;
use App\Modules\Access\Models\PositionAssignment;
use App\Modules\Audit\AttemptedOperation;
use App\Modules\Audit\AuditRecorder;
use App\Modules\Hr\Domain\EmploymentLifecycle;
use App\Modules\Hr\Models\Contract;
use App\Modules\Hr\Models\Employment;
use App\Modules\Hr\Models\EmploymentStatus;
use App\Modules\Hr\Models\Leave;
use App\Modules\Identity\Models\Person;
use App\Support\Authorization\AccessDecision;
use App\Support\Authorization\Actor;
use App\Support\Errors\AuthorizationDenied;
use App\Support\Errors\BusinessRejection;
use App\Support\Idempotency\IdempotentExecution;
use App\Support\Identifiers\RandomIdentifier;
use Illuminate\Support\Facades\DB;

/**
 * Employment lifecycle: verified person -> candidate -> active, with leave,
 * suspension, and termination. Every transition appends status history and
 * terminates nothing silently: termination closes open contracts, cancels
 * future approved leave, and revokes open position assignments so access
 * ends with employment.
 */
final class MaintainEmployment
{
    public const CAPABILITY = 'hr.employ';

    public const CAPABILITY_TERMINATE = 'hr.terminate';

    public function __construct(
        private readonly AccessDecision $access,
        private readonly IdempotentExecution $idempotency,
        private readonly AuditRecorder $audit,
        private readonly AttemptedOperation $attemptedOperation,
        private readonly TransitionPositionAssignment $assignments,
    ) {}

    /** @return array{employment_id: string, correlation_id: string} */
    public function employ(Actor $actor, string $personId, string $idempotencyKey): array
    {
        $payload = hash('sha256', implode('|', ['hr.employment.employ', $personId, $actor->actorId]));

        try {
            return $this->idempotency->execute('hr.employment.employ', $idempotencyKey, $payload,
                fn (): array => DB::transaction(function () use ($actor, $personId): array {
                    $this->require($actor, self::CAPABILITY);

                    /** @var Person|null $person */
                    $person = Person::query()->find($personId);
                    if ($person === null || ! $person->isVerified()) {
                        throw BusinessRejection::forCode('hr.person_not_verified', 'employment requires a verified person identity');
                    }
                    if (Employment::query()->where('person_id', $person->id)->where('lifecycle_state', '!=', EmploymentLifecycle::STATE_TERMINATED)->exists()) {
                        throw BusinessRejection::forCode('hr.employment_open_exists', 'this person already has an open employment');
                    }

                    $employment = Employment::query()->create([
                        'id' => RandomIdentifier::new(),
                        'person_id' => $person->id,
                        'lifecycle_state' => EmploymentLifecycle::STATE_CANDIDATE,
                    ]);
                    $this->appendStatus($employment, EmploymentLifecycle::STATE_CANDIDATE, 'employment opened', $actor);
                    $event = $this->audit->record($actor->actorId, 'hr.employment.employ', 'employment', $employment->id, null, ['person_id' => $person->id]);

                    return ['employment_id' => $employment->id, 'correlation_id' => $event->correlation_id];
                }),
            );
        } catch (AuthorizationDenied $denial) {
            $this->attemptedOperation->deniedByActor($denial, $actor, 'hr.employment.employ', 'employment', $personId);
        }
    }

    /** @return array{employment_id: string, lifecycle_state: string, correlation_id: string} */
    public function hire(Actor $actor, Employment $employment, string $effectiveFrom, string $idempotencyKey): array
    {
        return $this->transition($actor, $employment, EmploymentLifecycle::STATE_ACTIVE, 'hire', $effectiveFrom, $idempotencyKey,
            fn (Employment $locked): string => Contract::query()->where('employment_id', $locked->id)->where('lifecycle_state', 'active')->doesntExist() ? 'hr.hire_requires_contract' : '');
    }

    /** @return array{employment_id: string, lifecycle_state: string, correlation_id: string} */
    public function placeOnLeave(Actor $actor, Employment $employment, string $effectiveFrom, string $idempotencyKey): array
    {
        return $this->transition($actor, $employment, EmploymentLifecycle::STATE_ON_LEAVE, 'place_on_leave', $effectiveFrom, $idempotencyKey, null);
    }

    /** @return array{employment_id: string, lifecycle_state: string, correlation_id: string} */
    public function suspend(Actor $actor, Employment $employment, string $effectiveFrom, string $idempotencyKey): array
    {
        return $this->transition($actor, $employment, EmploymentLifecycle::STATE_SUSPENDED, 'suspend', $effectiveFrom, $idempotencyKey, null);
    }

    /** @return array{employment_id: string, lifecycle_state: string, correlation_id: string} */
    public function reinstate(Actor $actor, Employment $employment, string $effectiveFrom, string $idempotencyKey): array
    {
        return $this->transition($actor, $employment, EmploymentLifecycle::STATE_ACTIVE, 'reinstate', $effectiveFrom, $idempotencyKey, null);
    }

    /** @return array{employment_id: string, lifecycle_state: string, correlation_id: string} */
    public function terminate(Actor $actor, Employment $employment, string $effectiveFrom, string $reason, string $idempotencyKey): array
    {
        $payload = hash('sha256', implode('|', ['hr.employment.terminate', $employment->id, $effectiveFrom, $reason, $actor->actorId]));

        try {
            return $this->idempotency->execute('hr.employment.terminate', $idempotencyKey, $payload,
                fn (): array => DB::transaction(function () use ($actor, $employment, $effectiveFrom, $reason): array {
                    $this->require($actor, self::CAPABILITY_TERMINATE);
                    if ($reason === '') {
                        throw BusinessRejection::forCode('hr.termination_reason', 'a termination requires a reason');
                    }

                    /** @var Employment $locked */
                    $locked = Employment::query()->whereKey($employment->id)->lockForUpdate()->firstOrFail();
                    EmploymentLifecycle::requireTransition($locked->lifecycle_state, EmploymentLifecycle::STATE_TERMINATED);

                    Contract::query()->where('employment_id', $locked->id)->where('lifecycle_state', 'active')->update(['lifecycle_state' => 'closed', 'effective_to' => $effectiveFrom]);
                    Leave::query()->where('employment_id', $locked->id)->whereIn('lifecycle_state', ['requested', 'approved'])->update(['lifecycle_state' => 'cancelled']);
                    foreach (PositionAssignment::query()->where('person_id', $locked->person_id)->where('lifecycle_state', 'active')->get() as $assignment) {
                        $this->assignments->revoke($actor, $assignment, 'hr-terminate-'.$assignment->id);
                    }

                    $before = ['lifecycle_state' => $locked->lifecycle_state];
                    $locked->forceFill(['lifecycle_state' => EmploymentLifecycle::STATE_TERMINATED]);
                    $locked->save();
                    $this->appendStatus($locked, EmploymentLifecycle::STATE_TERMINATED, $reason, $actor);
                    $event = $this->audit->record($actor->actorId, 'hr.employment.terminate', 'employment', $locked->id, $before, ['lifecycle_state' => EmploymentLifecycle::STATE_TERMINATED, 'reason' => $reason]);

                    return ['employment_id' => $locked->id, 'lifecycle_state' => EmploymentLifecycle::STATE_TERMINATED, 'correlation_id' => $event->correlation_id];
                }),
            );
        } catch (AuthorizationDenied $denial) {
            $this->attemptedOperation->deniedByActor($denial, $actor, 'hr.employment.terminate', 'employment', $employment->id);
        }
    }

    /** @param callable(Employment): string|null $guard
     * @return array{employment_id: string, lifecycle_state: string, correlation_id: string} */
    private function transition(Actor $actor, Employment $employment, string $toState, string $verb, string $effectiveFrom, string $idempotencyKey, ?callable $guard): array
    {
        $payload = hash('sha256', implode('|', ['hr.employment.'.$verb, $employment->id, $toState, $effectiveFrom, $actor->actorId]));

        try {
            return $this->idempotency->execute('hr.employment.'.$verb, $idempotencyKey, $payload,
                fn (): array => DB::transaction(function () use ($actor, $employment, $toState, $verb, $effectiveFrom, $guard): array {
                    $this->require($actor, self::CAPABILITY);

                    /** @var Employment $locked */
                    $locked = Employment::query()->whereKey($employment->id)->lockForUpdate()->firstOrFail();
                    EmploymentLifecycle::requireTransition($locked->lifecycle_state, $toState);
                    if ($guard !== null) {
                        $errorCode = $guard($locked);
                        if ($errorCode !== '') {
                            throw BusinessRejection::forCode($errorCode, 'the transition guard rejected this change');
                        }
                    }

                    $before = ['lifecycle_state' => $locked->lifecycle_state];
                    $locked->forceFill(['lifecycle_state' => $toState]);
                    $locked->save();
                    $this->appendStatus($locked, $toState, $verb, $actor);
                    $event = $this->audit->record($actor->actorId, 'hr.employment.'.$verb, 'employment', $locked->id, $before, ['lifecycle_state' => $toState, 'effective_from' => $effectiveFrom]);

                    return ['employment_id' => $locked->id, 'lifecycle_state' => $toState, 'correlation_id' => $event->correlation_id];
                }),
            );
        } catch (AuthorizationDenied $denial) {
            $this->attemptedOperation->deniedByActor($denial, $actor, 'hr.employment.'.$verb, 'employment', $employment->id);
        }
    }

    private function appendStatus(Employment $employment, string $status, string $reason, Actor $actor): EmploymentStatus
    {
        /** @var EmploymentStatus $fact */
        $fact = EmploymentStatus::query()->create([
            'id' => RandomIdentifier::new(),
            'employment_id' => $employment->id,
            'status' => $status,
            'effective_from' => now()->toDateString(),
            'reason' => $reason,
            'actor_id' => $actor->actorId,
        ]);

        return $fact;
    }

    private function require(Actor $actor, string $capability): void
    {
        $outcome = $this->access->decide($actor, $capability, null);
        if (! $outcome->allowed) {
            throw AuthorizationDenied::forCode('hr.employment_denied', $outcome->reason);
        }
    }
}
