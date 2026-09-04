<?php

declare(strict_types=1);

namespace App\Modules\Academic\Placement\Commands;

use App\Modules\Academic\Placement\Domain\PlacementAccess;
use App\Modules\Academic\Placement\Domain\PlacementProfileLifecycle;
use App\Modules\Academic\Placement\Models\PlacementAttempt;
use App\Modules\Academic\Placement\Models\PlacementProfile;
use App\Modules\Academic\Placement\Models\PlacementSectionResult;
use App\Modules\Audit\AttemptedOperation;
use App\Modules\Audit\AuditRecorder;
use App\Support\Authorization\Actor;
use App\Support\Errors\AuthorizationDenied;
use App\Support\Errors\BusinessRejection;
use App\Support\Idempotency\IdempotentExecution;
use Illuminate\Support\Facades\DB;

/**
 * The profile-level Placement Decision chain: review -> approve -> release,
 * each step an independent signer, with the recommendation retained as
 * immutable history. A retake supersedes the live profile and reopens one.
 */
final class DecidePlacement
{
    public const CAPABILITY_REVIEW = 'placement.moderate';

    public const CAPABILITY_APPROVE = 'placement.approve';

    public const CAPABILITY_RELEASE = 'placement.release';

    public function __construct(
        private readonly PlacementAccess $access,
        private readonly IdempotentExecution $idempotency,
        private readonly AuditRecorder $audit,
        private readonly AttemptedOperation $attemptedOperation,
    ) {}

    /** @return array{profile_id: string, lifecycle_state: string, correlation_id: string} */
    public function review(Actor $reviewer, PlacementProfile $profile, string $idempotencyKey): array
    {
        return $this->transition($reviewer, $profile, PlacementProfile::STATE_REVIEWED, self::CAPABILITY_REVIEW, 'review', $idempotencyKey, function (PlacementProfile $locked, Actor $actor): void {
            if (! $this->allSectionsApproved($locked->id)) {
                throw BusinessRejection::forCode('placement.review_sections_not_approved', 'every placement section must be approved before review');
            }
        });
    }

    /** @return array{profile_id: string, lifecycle_state: string, correlation_id: string} */
    public function approve(Actor $approver, PlacementProfile $profile, string $idempotencyKey): array
    {
        return $this->transition($approver, $profile, PlacementProfile::STATE_APPROVED, self::CAPABILITY_APPROVE, 'approve', $idempotencyKey, function (PlacementProfile $locked, Actor $actor): void {
            if (trim((string) $locked->reviewed_by) === $actor->actorId) {
                throw AuthorizationDenied::forCode('placement.approval_not_independent', 'the approver must differ from the reviewer');
            }
        });
    }

    /** @return array{profile_id: string, lifecycle_state: string, correlation_id: string} */
    public function release(Actor $releaser, PlacementProfile $profile, string $idempotencyKey): array
    {
        return $this->transition($releaser, $profile, PlacementProfile::STATE_RELEASED, self::CAPABILITY_RELEASE, 'release', $idempotencyKey, null);
    }

    /** @return array{profile_id: string, lifecycle_state: string, correlation_id: string} */
    public function supersede(Actor $actor, PlacementProfile $profile, string $idempotencyKey): array
    {
        return $this->transition($actor, $profile, PlacementProfile::STATE_SUPERSEDED, self::CAPABILITY_RELEASE, 'supersede', $idempotencyKey, function (PlacementProfile $locked, Actor $actor): void {
            if ($locked->lifecycle_state !== PlacementProfile::STATE_RELEASED) {
                throw BusinessRejection::forCode('placement.supersede_released_only', 'only a released placement profile can be superseded');
            }
        });
    }

    /** @return array{profile_id: string, lifecycle_state: string, correlation_id: string} */
    private function transition(Actor $actor, PlacementProfile $profile, string $toState, string $capability, string $verb, string $idempotencyKey, ?callable $guard): array
    {
        $payload = hash('sha256', implode('|', ['placement.'.$verb, $profile->id, $toState, $actor->actorId]));

        try {
            return $this->idempotency->execute('placement.'.$verb, $idempotencyKey, $payload,
                fn (): array => DB::transaction(function () use ($actor, $profile, $toState, $capability, $verb, $guard): array {
                    /** @var PlacementProfile $locked */
                    $locked = PlacementProfile::query()->whereKey($profile->id)->lockForUpdate()->firstOrFail();
                    $this->access->require($actor, $capability, $locked->originating_branch_id);
                    PlacementProfileLifecycle::requireTransition($locked->lifecycle_state, $toState);
                    if ($guard !== null) {
                        $guard($locked, $actor);
                    }
                    $before = ['lifecycle_state' => $locked->lifecycle_state];
                    $changes = ['lifecycle_state' => $toState];
                    if ($toState === PlacementProfile::STATE_REVIEWED) {
                        $changes['reviewed_by'] = $actor->actorId;
                    } elseif ($toState === PlacementProfile::STATE_APPROVED) {
                        $changes['approved_by'] = $actor->actorId;
                    } elseif ($toState === PlacementProfile::STATE_RELEASED) {
                        $changes['released_by'] = $actor->actorId;
                    }
                    $locked->forceFill($changes)->save();
                    $event = $this->audit->record($actor->actorId, 'placement.'.$verb, 'placement_profile', $locked->id, $before, ['lifecycle_state' => $toState]);

                    return ['profile_id' => $locked->id, 'lifecycle_state' => $toState, 'correlation_id' => $event->correlation_id];
                }),
            );
        } catch (AuthorizationDenied $denial) {
            $this->attemptedOperation->deniedByActor($denial, $actor, 'placement.'.$verb, 'placement_profile', $profile->id);
        }
    }

    private function allSectionsApproved(string $profileId): bool
    {
        $attempt = PlacementAttempt::query()
            ->where('profile_id', $profileId)
            ->where('status', 'submitted')
            ->latest('id')
            ->first();
        if ($attempt === null) {
            return false;
        }

        return PlacementSectionResult::query()
            ->where('attempt_id', $attempt->id)
            ->where('lifecycle_state', '!=', PlacementSectionResult::STATE_APPROVED)
            ->doesntExist();
    }
}
