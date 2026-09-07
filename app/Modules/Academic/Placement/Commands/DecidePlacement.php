<?php

declare(strict_types=1);

namespace App\Modules\Academic\Placement\Commands;

use App\Modules\Academic\Placement\Domain\AcademicEligibilitySnapshotBuilder;
use App\Modules\Academic\Placement\Domain\PlacementAccess;
use App\Modules\Academic\Placement\Domain\PlacementEvidenceVerifier;
use App\Modules\Academic\Placement\Domain\PlacementProfileLifecycle;
use App\Modules\Academic\Placement\Models\AcademicEligibilitySnapshot;
use App\Modules\Academic\Placement\Models\PlacementAttempt;
use App\Modules\Academic\Placement\Models\PlacementProfile;
use App\Modules\Academic\Placement\Models\PlacementRecommendation;
use App\Modules\Academic\Placement\Models\PlacementSectionResult;
use App\Modules\Audit\AttemptedOperation;
use App\Modules\Audit\AuditRecorder;
use App\Modules\Organization\Models\Branch;
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
        private readonly PlacementEvidenceVerifier $evidenceVerifier,
    ) {}

    /** @return array{profile_id: string, lifecycle_state: string, correlation_id: string} */
    public function review(Actor $reviewer, PlacementProfile $profile, string $idempotencyKey): array
    {
        return $this->transition($reviewer, $profile, PlacementProfile::STATE_REVIEWED, self::CAPABILITY_REVIEW, 'review', $idempotencyKey, function (PlacementProfile $locked, Actor $actor): void {
            if (! $this->allSectionsApproved($locked)) {
                throw BusinessRejection::forCode('placement.review_sections_not_approved', 'the exact recommendation attempt must have a complete, approved result chain before review');
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

    /** @return array{profile_id: string, lifecycle_state: string, released_at: string|null, release_time_basis: string|null, correlation_id: string} */
    public function release(Actor $releaser, PlacementProfile $profile, string $idempotencyKey): array
    {
        // Recheck evidence at the terminal boundary. The review command is
        // not treated as a proxy for current integrity, especially when a
        // raw writer may have attempted a bypass between stages.
        return $this->transition($releaser, $profile, PlacementProfile::STATE_RELEASED, self::CAPABILITY_RELEASE, 'release', $idempotencyKey, function (PlacementProfile $locked, Actor $actor): void {
            if (! $this->allSectionsApproved($locked)) {
                throw BusinessRejection::forCode('placement.release_evidence_invalid', 'release requires the exact complete, approved, integrity-verified recommendation evidence');
            }
        });
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

    /** @return array{profile_id: string, lifecycle_state: string, released_at?: string|null, release_time_basis?: string|null, correlation_id: string} */
    private function transition(Actor $actor, PlacementProfile $profile, string $toState, string $capability, string $verb, string $idempotencyKey, ?callable $guard): array
    {
        $payload = hash('sha256', implode('|', ['placement.'.$verb, $profile->id, $toState, $actor->actorId]));

        try {
            return $this->idempotency->execute('placement.'.$verb, $idempotencyKey, $payload,
                fn (): array => DB::transaction(function () use ($actor, $profile, $toState, $capability, $verb, $guard): array {
                    /** @var PlacementProfile $locked */
                    $locked = PlacementProfile::query()->whereKey($profile->id)->lockForUpdate()->firstOrFail();
                    $this->access->require($actor, $capability, $locked->originating_branch_id);
                    if ($locked->lineage_version !== PlacementProfile::LINEAGE_VERSION) {
                        throw BusinessRejection::forCode('placement.profile_lineage_remediation_required', 'a pre-lineage placement profile requires governed remediation before a decision transition');
                    }
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
                    if ($toState === PlacementProfile::STATE_RELEASED) {
                        // The database, not a caller timestamp, records the
                        // accepted release transition. Reload that immutable
                        // event fact before constructing its audit evidence and
                        // linked eligibility snapshot.
                        /** @var PlacementProfile $locked */
                        $locked = PlacementProfile::query()->whereKey($locked->id)->firstOrFail();
                    }

                    $after = ['lifecycle_state' => $toState];
                    if ($toState === PlacementProfile::STATE_RELEASED) {
                        $snapshot = $this->materializeEligibilitySnapshot($locked, $actor);
                        $after['academic_eligibility_snapshot_id'] = $snapshot->id;
                        $after['released_at'] = $locked->released_at;
                        $after['release_time_basis'] = $locked->release_time_basis;
                    }
                    $after = array_merge($after, $this->branchProvenance($locked->originating_branch_id));
                    $event = $this->audit->record($actor->actorId, 'placement.'.$verb, 'placement_profile', $locked->id, $before, $after);

                    $result = ['profile_id' => $locked->id, 'lifecycle_state' => $toState, 'correlation_id' => $event->correlation_id];
                    if ($toState === PlacementProfile::STATE_RELEASED) {
                        // The transport caller receives the same database-owned
                        // event fact that the audit event records, rather than
                        // inferring a release time from response delivery.
                        $result['released_at'] = $locked->released_at;
                        $result['release_time_basis'] = $locked->release_time_basis;
                    }

                    return $result;
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

        $recommendationId = trim((string) ($profile->placement_recommendation_id ?? ''));
        if ($recommendationId === '') {
            throw BusinessRejection::forCode('placement.snapshot_recommendation_missing', 'a released placement profile requires its explicit immutable recommendation pointer');
        }
        /** @var PlacementRecommendation $recommendation */
        $recommendation = PlacementRecommendation::query()->whereKey($recommendationId)->lockForUpdate()->firstOrFail();
        if (trim((string) $recommendation->profile_id) !== trim((string) $profile->id)
            || $recommendation->lineage_version !== PlacementRecommendation::LINEAGE_VERSION) {
            throw BusinessRejection::forCode('placement.snapshot_recommendation_mismatch', 'the profile recommendation pointer does not identify a valid immutable recommendation');
        }

        // A v2 profile receives exactly one immutable release snapshot; a
        // later retake receives a distinct profile and links through the
        // person's explicit supersession chain rather than incrementing a
        // mutable profile-local revision.
        $versionNo = 1;

        // UUID primary keys and same-second timestamps are not an ordering
        // authority. Serialize per person before discovering the explicit
        // chain tail. The database trigger takes the same transaction lock so
        // raw SQL cannot race the command into a second root or successor.
        DB::select('SELECT pg_advisory_xact_lock(hashtext(?))', [$profile->person_id]);
        // The only valid predecessor is the unique current tail of the
        // explicit supersession chain; multiple tails are historical ambiguity
        // that must be remediated rather than guessed.
        $personSnapshots = AcademicEligibilitySnapshot::query()
            ->where('person_id', $profile->person_id)
            ->lockForUpdate()
            ->get();
        $supersededIds = $personSnapshots
            ->pluck('supersedes_snapshot_id')
            ->filter(static fn ($id): bool => $id !== null && trim((string) $id) !== '')
            ->map(static fn ($id): string => (string) $id)
            ->all();
        $tails = $personSnapshots
            ->filter(static fn (AcademicEligibilitySnapshot $snapshot): bool => ! in_array((string) $snapshot->id, $supersededIds, true))
            ->values();
        if ($tails->count() > 1) {
            throw BusinessRejection::forCode('placement.snapshot_lineage_ambiguous', 'multiple eligibility snapshot lineage tails require governed remediation before a new snapshot can be linked');
        }
        /** @var AcademicEligibilitySnapshot|null $previous */
        $previous = $tails->first();
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
            ...$this->branchProvenance($profile->originating_branch_id),
        ]);

        return $snapshot;
    }

    /** @return array{branch_id: string, campus_id: string, organization_id: string} */
    private function branchProvenance(?string $branchId): array
    {
        $id = trim((string) ($branchId ?? ''));
        if ($id === '') {
            throw BusinessRejection::forCode('placement.decision_provenance_required', 'a placement decision requires an operational branch provenance');
        }
        $branch = Branch::query()->whereKey($id)->first();
        if ($branch === null || $branch->lifecycle_state !== 'active') {
            throw BusinessRejection::forCode('placement.decision_provenance_required', 'a placement decision requires an active branch provenance');
        }
        $scope = $branch->structureScope();
        if ($scope->organizationId === '' || $scope->campusId === null) {
            throw BusinessRejection::forCode('placement.decision_provenance_required', 'a placement decision requires active campus organization provenance');
        }

        return ['branch_id' => (string) $branch->id, 'campus_id' => (string) $scope->campusId, 'organization_id' => $scope->organizationId];
    }

    private function allSectionsApproved(PlacementProfile $profile): bool
    {
        $recommendationId = trim((string) ($profile->placement_recommendation_id ?? ''));
        if ($recommendationId === '') {
            return false;
        }
        /** @var PlacementRecommendation|null $recommendation */
        $recommendation = PlacementRecommendation::query()->find($recommendationId);
        if ($recommendation === null
            || $recommendation->lineage_version !== PlacementRecommendation::LINEAGE_VERSION
            || trim((string) $recommendation->profile_id) !== trim((string) $profile->id)
            || trim((string) $recommendation->attempt_id) === '') {
            return false;
        }
        /** @var PlacementAttempt|null $attempt */
        $attempt = PlacementAttempt::query()->find($recommendation->attempt_id);
        if ($attempt === null || trim((string) $attempt->profile_id) !== trim((string) $profile->id)) {
            return false;
        }

        $this->evidenceVerifier->requireDecisionEligible($attempt);
        if (! $this->evidenceVerifier->scoringIsComplete($attempt)) {
            return false;
        }

        return PlacementSectionResult::query()
            ->where('attempt_id', $attempt->id)
            ->where('lifecycle_state', '!=', PlacementSectionResult::STATE_APPROVED)
            ->doesntExist();
    }
}
