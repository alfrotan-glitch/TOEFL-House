<?php

declare(strict_types=1);

namespace App\Modules\Academic\Placement\Commands;

use App\Modules\Academic\Placement\Domain\AcademicEligibilitySnapshotBuilder;
use App\Modules\Academic\Placement\Domain\PlacementAccess;
use App\Modules\Academic\Placement\Domain\PlacementProfileLifecycle;
use App\Modules\Academic\Placement\Models\AcademicEligibilitySnapshot;
use App\Modules\Academic\Placement\Models\PlacementAttempt;
use App\Modules\Academic\Placement\Models\PlacementProfile;
use App\Modules\Academic\Placement\Models\PlacementRecommendation;
use App\Modules\Academic\Placement\Models\PlacementSectionResult;
use App\Modules\Audit\AttemptedOperation;
use App\Modules\Audit\AuditRecorder;
use App\Support\Authorization\Actor;
use App\Support\Errors\AuthorizationDenied;
use App\Support\Errors\BusinessRejection;
use App\Support\Idempotency\IdempotentExecution;
use App\Support\Identifiers\RandomIdentifier;
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

                    $after = ['lifecycle_state' => $toState];
                    if ($toState === PlacementProfile::STATE_RELEASED) {
                        $snapshot = $this->materializeEligibilitySnapshot($locked, $actor);
                        $after['academic_eligibility_snapshot_id'] = $snapshot->id;
                    }
                    $event = $this->audit->record($actor->actorId, 'placement.'.$verb, 'placement_profile', $locked->id, $before, $after);

                    return ['profile_id' => $locked->id, 'lifecycle_state' => $toState, 'correlation_id' => $event->correlation_id];
                }),
            );
        } catch (AuthorizationDenied $denial) {
            $this->attemptedOperation->deniedByActor($denial, $actor, 'placement.'.$verb, 'placement_profile', $profile->id);
        }
    }

    private function materializeEligibilitySnapshot(PlacementProfile $profile, Actor $releaser): AcademicEligibilitySnapshot
    {
        if (AcademicEligibilitySnapshot::query()->where('placement_profile_id', $profile->id)->exists()) {
            throw BusinessRejection::forCode('placement.eligibility_snapshot_exists', 'this placement profile already has a signed eligibility snapshot');
        }

        /** @var PlacementRecommendation $recommendation */
        $recommendation = PlacementRecommendation::query()
            ->where('profile_id', $profile->id)
            ->latest('created_at')
            ->firstOrFail();

        $versionNo = (int) AcademicEligibilitySnapshot::query()
            ->where('placement_profile_id', $profile->id)
            ->count() + 1;

        /** @var AcademicEligibilitySnapshot|null $previous */
        $previous = AcademicEligibilitySnapshot::query()
            ->where('person_id', $profile->person_id)
            ->latest('signed_at')
            ->first();
        $supersedesSnapshotId = $previous?->id;

        $built = (new AcademicEligibilitySnapshotBuilder)->build(
            $profile,
            $recommendation,
            $releaser,
            $versionNo,
            $supersedesSnapshotId,
        );

        $snapshot = AcademicEligibilitySnapshot::query()->create([
            'id' => RandomIdentifier::new(),
            'placement_profile_id' => $profile->id,
            'placement_recommendation_id' => $recommendation->id,
            'person_id' => $profile->person_id,
            'visitor_id' => $profile->visitor_id,
            'snapshot_schema_version' => AcademicEligibilitySnapshotBuilder::SCHEMA_VERSION,
            'version_no' => $versionNo,
            'program_version_id' => $built['program_version_id'],
            'recommended_level_id' => $built['recommended_level_id'],
            'recommended_class_id' => $built['recommended_class_id'],
            'recommended_offering_id' => $built['recommended_offering_id'],
            'academic_period_id' => $built['academic_period_id'],
            'originating_branch_id' => $profile->originating_branch_id,
            'current_home_branch_id' => $profile->current_home_branch_id,
            'payload' => $built['payload'],
            'payload_canonical_json' => $built['canonical'],
            'payload_sha256' => $built['digest'],
            'signature_algorithm' => $built['algorithm'],
            'signature' => $built['signature'],
            'signing_key_version' => $built['key_version'],
            'signed_by' => $releaser->actorId,
            'signed_at' => $built['payload']['snapshot']['signed_at'],
            'supersedes_snapshot_id' => $supersedesSnapshotId,
        ]);

        $profile->forceFill(['academic_eligibility_snapshot_id' => $snapshot->id])->save();

        $this->audit->record($releaser->actorId, 'placement.eligibility.snapshot', 'academic_eligibility_snapshot', $snapshot->id, null, [
            'placement_profile_id' => $profile->id,
            'placement_recommendation_id' => $recommendation->id,
            'snapshot_schema_version' => $snapshot->snapshot_schema_version,
            'version_no' => $snapshot->version_no,
            'payload_sha256' => $snapshot->payload_sha256,
            'signature_algorithm' => $snapshot->signature_algorithm,
            'signing_key_version' => $snapshot->signing_key_version,
        ]);

        return $snapshot;
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
