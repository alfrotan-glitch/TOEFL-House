<?php

declare(strict_types=1);

namespace App\Modules\Academic\Commands;

use App\Modules\Academic\Domain\AcademicAccess;
use App\Modules\Academic\Domain\BranchAvailabilityLifecycle;
use App\Modules\Academic\Domain\OfferingLifecycle;
use App\Modules\Academic\Models\AcademicPeriod;
use App\Modules\Academic\Models\BranchAvailability;
use App\Modules\Academic\Models\Enrollment;
use App\Modules\Academic\Models\Offering;
use App\Modules\Academic\Models\ProgramVersionLevel;
use App\Modules\Audit\AttemptedOperation;
use App\Modules\Audit\AuditRecorder;
use App\Support\Authorization\Actor;
use App\Support\Errors\AuthorizationDenied;
use App\Support\Errors\BusinessRejection;
use App\Support\Idempotency\IdempotentExecution;
use Illuminate\Support\Facades\DB;

/**
 * Offering and branch-availability lifecycle: close/reopen an availability or
 * offering, cancel/complete an offering once its open seats are gone, and
 * resize an offering capacity without ever dropping below the active seat
 * count. All transitions are authorized, audited, and idempotent.
 */
final class ManageAcademicOffering
{
    public const CAPABILITY = 'academic.structure';

    public function __construct(
        private readonly AcademicAccess $access,
        private readonly IdempotentExecution $idempotency,
        private readonly AuditRecorder $audit,
        private readonly AttemptedOperation $attemptedOperation,
    ) {}

    /** @return array{availability_id: string, lifecycle_state: string, correlation_id: string} */
    public function closeAvailability(Actor $actor, BranchAvailability $availability, string $idempotencyKey): array
    {
        return $this->transitionAvailability($actor, $availability, BranchAvailabilityLifecycle::STATE_CLOSED, $idempotencyKey);
    }

    /** @return array{availability_id: string, lifecycle_state: string, correlation_id: string} */
    public function reopenAvailability(Actor $actor, BranchAvailability $availability, string $idempotencyKey): array
    {
        return $this->transitionAvailability($actor, $availability, BranchAvailabilityLifecycle::STATE_ACTIVE, $idempotencyKey);
    }

    /** @return array{availability_id: string, lifecycle_state: string, correlation_id: string} */
    private function transitionAvailability(Actor $actor, BranchAvailability $availability, string $toState, string $idempotencyKey): array
    {
        $payload = hash('sha256', implode('|', ['academic.availability.transition', $availability->id, $toState, $actor->actorId]));

        try {
            return $this->idempotency->execute('academic.availability.transition.'.$toState, $idempotencyKey, $payload,
                fn (): array => DB::transaction(function () use ($actor, $availability, $toState): array {
                    /** @var BranchAvailability $locked */
                    $locked = BranchAvailability::query()->whereKey($availability->id)->lockForUpdate()->firstOrFail();
                    $this->requireCapability($actor, (string) $locked->branch_id);
                    $from = $locked->lifecycle_state;
                    BranchAvailabilityLifecycle::requireTransition($from, $toState);

                    if ($toState === BranchAvailabilityLifecycle::STATE_ACTIVE) {
                        $this->assertAvailabilityReopenContext($locked);
                    }
                    if ($toState === BranchAvailabilityLifecycle::STATE_CLOSED) {
                        $open = Offering::query()
                            ->where('branch_id', $locked->branch_id)
                            ->where('program_version_level_id', $locked->program_version_level_id)
                            ->where('academic_period_id', $locked->academic_period_id)
                            ->where('lifecycle_state', Offering::STATE_OPEN)
                            ->count();
                        if ($open > 0) {
                            throw BusinessRejection::forCode('academic.availability_open_offerings', "availability cannot close while {$open} open offering(s) reference it");
                        }
                    }

                    $locked->forceFill(['lifecycle_state' => $toState])->save();
                    $event = $this->audit->record($actor->actorId, 'academic.availability.transition.'.$toState, 'branch_availability', $locked->id, ['lifecycle_state' => $from], ['lifecycle_state' => $toState]);

                    return ['availability_id' => $locked->id, 'lifecycle_state' => $toState, 'correlation_id' => $event->correlation_id];
                }),
            );
        } catch (AuthorizationDenied $denial) {
            $this->attemptedOperation->deniedByActor($denial, $actor, 'academic.availability.transition', 'branch_availability', $availability->id);
        }
    }

    /** @return array{offering_id: string, lifecycle_state: string, correlation_id: string} */
    public function closeOffering(Actor $actor, Offering $offering, string $idempotencyKey): array
    {
        return $this->transitionOffering($actor, $offering, OfferingLifecycle::STATE_CLOSED, $idempotencyKey);
    }

    /** @return array{offering_id: string, lifecycle_state: string, correlation_id: string} */
    public function reopenOffering(Actor $actor, Offering $offering, string $idempotencyKey): array
    {
        return $this->transitionOffering($actor, $offering, OfferingLifecycle::STATE_OPEN, $idempotencyKey);
    }

    /** @return array{offering_id: string, lifecycle_state: string, correlation_id: string} */
    public function cancelOffering(Actor $actor, Offering $offering, string $idempotencyKey): array
    {
        return $this->transitionOffering($actor, $offering, OfferingLifecycle::STATE_CANCELLED, $idempotencyKey);
    }

    /** @return array{offering_id: string, lifecycle_state: string, correlation_id: string} */
    public function completeOffering(Actor $actor, Offering $offering, string $idempotencyKey): array
    {
        return $this->transitionOffering($actor, $offering, OfferingLifecycle::STATE_COMPLETED, $idempotencyKey);
    }

    /** @return array{offering_id: string, lifecycle_state: string, correlation_id: string} */
    private function transitionOffering(Actor $actor, Offering $offering, string $toState, string $idempotencyKey): array
    {
        $payload = hash('sha256', implode('|', ['academic.offering.transition', $offering->id, $toState, $actor->actorId]));

        try {
            return $this->idempotency->execute('academic.offering.transition.'.$toState, $idempotencyKey, $payload,
                fn (): array => DB::transaction(function () use ($actor, $offering, $toState): array {
                    /** @var Offering $locked */
                    $locked = Offering::query()->whereKey($offering->id)->lockForUpdate()->firstOrFail();
                    $this->requireCapability($actor, (string) $locked->branch_id);
                    $from = $locked->lifecycle_state;
                    OfferingLifecycle::requireTransition($from, $toState);

                    if ($toState === OfferingLifecycle::STATE_OPEN) {
                        $this->assertOfferingReopenContext($locked);
                    }
                    if (in_array($toState, [OfferingLifecycle::STATE_CANCELLED, OfferingLifecycle::STATE_COMPLETED], true)) {
                        $openSeats = Enrollment::query()->where('offering_id', $locked->id)
                            ->whereIn('lifecycle_state', ['requested', 'active', 'frozen'])
                            ->count();
                        if ($openSeats > 0) {
                            throw BusinessRejection::forCode('academic.offering_open_seats', "offering cannot move to {$toState} while {$openSeats} open enrollment seat(s) reference it");
                        }
                    }

                    $locked->forceFill(['lifecycle_state' => $toState])->save();
                    $event = $this->audit->record($actor->actorId, 'academic.offering.transition.'.$toState, 'offering', $locked->id, ['lifecycle_state' => $from], ['lifecycle_state' => $toState]);

                    return ['offering_id' => $locked->id, 'lifecycle_state' => $toState, 'correlation_id' => $event->correlation_id];
                }),
            );
        } catch (AuthorizationDenied $denial) {
            $this->attemptedOperation->deniedByActor($denial, $actor, 'academic.offering.transition', 'offering', $offering->id);
        }
    }

    /** @return array{offering_id: string, capacity: int, correlation_id: string} */
    public function resizeCapacity(Actor $actor, Offering $offering, int $capacity, string $idempotencyKey): array
    {
        $payload = hash('sha256', implode('|', ['academic.offering.resize', $offering->id, (string) $capacity, $actor->actorId]));

        try {
            return $this->idempotency->execute('academic.offering.resize', $idempotencyKey, $payload,
                fn (): array => DB::transaction(function () use ($actor, $offering, $capacity): array {
                    /** @var Offering $locked */
                    $locked = Offering::query()->whereKey($offering->id)->lockForUpdate()->firstOrFail();
                    $this->requireCapability($actor, (string) $locked->branch_id);
                    if ($capacity < 1) {
                        throw BusinessRejection::forCode('academic.offering_capacity_positive', 'an offering requires a positive capacity');
                    }

                    $activeSeats = Enrollment::query()->where('offering_id', $locked->id)->where('lifecycle_state', 'active')->count();
                    if ($capacity < $activeSeats) {
                        throw BusinessRejection::forCode('academic.offering_capacity_below_active', "offering capacity cannot fall below its {$activeSeats} active seat(s)");
                    }
                    if ($locked->capacity === $capacity) {
                        throw BusinessRejection::forCode('academic.offering_capacity_unchanged', 'offering capacity is already set to this value');
                    }

                    $before = ['capacity' => $locked->capacity];
                    $locked->forceFill(['capacity' => $capacity])->save();
                    $event = $this->audit->record($actor->actorId, 'academic.offering.resize', 'offering', $locked->id, $before, ['capacity' => $capacity]);

                    return ['offering_id' => $locked->id, 'capacity' => $capacity, 'correlation_id' => $event->correlation_id];
                }),
            );
        } catch (AuthorizationDenied $denial) {
            $this->attemptedOperation->deniedByActor($denial, $actor, 'academic.offering.resize', 'offering', $offering->id);
        }
    }

    private function assertAvailabilityReopenContext(BranchAvailability $availability): void
    {
        /** @var AcademicPeriod $period */
        $period = AcademicPeriod::query()->whereKey($availability->academic_period_id)->firstOrFail();
        if ($period->lifecycle_state !== 'published') {
            throw BusinessRejection::forCode('academic.offering_period_not_open', 'the offering term must be published/open to reopen');
        }

        /** @var ProgramVersionLevel $level */
        $level = ProgramVersionLevel::query()->whereKey($availability->program_version_level_id)->firstOrFail();
        if ($level->lifecycle_state !== 'active') {
            throw BusinessRejection::forCode('academic.offering_level_not_active', 'the program-version level must be active to reopen');
        }
    }

    private function assertOfferingReopenContext(Offering $offering): void
    {
        $availability = BranchAvailability::query()
            ->where('branch_id', $offering->branch_id)
            ->where('program_version_level_id', $offering->program_version_level_id)
            ->where('academic_period_id', $offering->academic_period_id)
            ->where('lifecycle_state', BranchAvailability::STATE_ACTIVE)
            ->exists();
        if (! $availability) {
            throw BusinessRejection::forCode('academic.offering_without_availability', 'an offering requires an active branch availability to reopen');
        }

        /** @var AcademicPeriod $period */
        $period = AcademicPeriod::query()->whereKey($offering->academic_period_id)->firstOrFail();
        if ($period->lifecycle_state !== 'published') {
            throw BusinessRejection::forCode('academic.offering_period_not_open', 'the offering term must be published/open to reopen');
        }
    }

    private function requireCapability(Actor $actor, ?string $branchId): void
    {
        $this->access->require($actor, self::CAPABILITY, $branchId, 'academic.structure_denied');
    }
}
