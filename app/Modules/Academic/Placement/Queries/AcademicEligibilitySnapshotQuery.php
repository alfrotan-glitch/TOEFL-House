<?php

declare(strict_types=1);

namespace App\Modules\Academic\Placement\Queries;

use App\Modules\Academic\Placement\Domain\AcademicEligibilitySnapshotBuilder;
use App\Modules\Academic\Placement\Models\AcademicEligibilitySnapshot;
use App\Modules\Academic\Placement\Models\PlacementProfile;
use App\Support\Signing\AcademicEligibilitySigner;
use App\Support\Signing\CanonicalJson;
use Illuminate\Support\Carbon;

/**
 * Read-only consumption surface for signed academic eligibility snapshots.
 * Admissions, Academic and Finance consume the same verified payload so the
 * whole enterprise sees one immutable, auditable academic context.
 */
final class AcademicEligibilitySnapshotQuery
{
    /** @return array<string, mixed>|null */
    public function for(PlacementProfile $profile): ?array
    {
        $snapshot = AcademicEligibilitySnapshot::query()
            ->where('placement_profile_id', $profile->id)
            ->latest('version_no')
            ->first();

        return $snapshot === null ? null : $this->present($snapshot);
    }

    /** @return array<string, mixed> */
    public function present(AcademicEligibilitySnapshot $snapshot): array
    {
        $verification = $this->verify($snapshot);

        return [
            'snapshot' => [
                'id' => $snapshot->id,
                'placement_profile_id' => $snapshot->placement_profile_id,
                'placement_recommendation_id' => $snapshot->placement_recommendation_id,
                'person_id' => $snapshot->person_id,
                'snapshot_schema_version' => $snapshot->snapshot_schema_version,
                'version_no' => (int) $snapshot->version_no,
                'program_version_id' => $snapshot->program_version_id,
                'recommended_level_id' => $snapshot->recommended_level_id,
                'recommended_class_id' => $snapshot->recommended_class_id,
                'recommended_offering_id' => $snapshot->recommended_offering_id,
                'academic_period_id' => $snapshot->academic_period_id,
                'originating_branch_id' => $snapshot->originating_branch_id,
                'current_home_branch_id' => $snapshot->current_home_branch_id,
                'payload_sha256' => $snapshot->payload_sha256,
                'signature_algorithm' => $snapshot->signature_algorithm,
                'signing_key_version' => $snapshot->signing_key_version,
                'signature' => $snapshot->signature,
                'signed_by' => $snapshot->signed_by,
                'signed_at' => Carbon::parse($snapshot->signed_at)->toIso8601String(),
                'supersedes_snapshot_id' => $snapshot->supersedes_snapshot_id,
            ],
            'payload' => $snapshot->payload,
            'canonical' => $snapshot->payload_canonical_json,
            'verification' => $verification,
        ];
    }

    /** @return list<array<string, mixed>> */
    public function forPerson(string $personId): array
    {
        return AcademicEligibilitySnapshot::query()
            ->where('person_id', $personId)
            ->orderByDesc('signed_at')
            ->get()
            ->map(fn (AcademicEligibilitySnapshot $snapshot): array => $this->present($snapshot))
            ->all();
    }

    /** @return list<array<string, mixed>> */
    public function historyForPerson(string $personId): array
    {
        return $this->forPerson($personId);
    }

    /** @return array{valid: bool, reason: string} */
    public function verify(AcademicEligibilitySnapshot $snapshot): array
    {
        if ($snapshot->signature_algorithm !== AcademicEligibilitySigner::ALGORITHM) {
            return ['valid' => false, 'reason' => 'unexpected signature algorithm: '.$snapshot->signature_algorithm];
        }

        if ($snapshot->signing_key_version !== AcademicEligibilitySigner::KEY_VERSION) {
            return ['valid' => false, 'reason' => 'unexpected signing key version: '.$snapshot->signing_key_version];
        }

        if ($snapshot->snapshot_schema_version !== AcademicEligibilitySnapshotBuilder::SCHEMA_VERSION) {
            return ['valid' => false, 'reason' => 'unexpected snapshot schema version: '.$snapshot->snapshot_schema_version];
        }

        $canonical = CanonicalJson::encode($snapshot->payload);
        $digest = hash('sha256', $canonical);

        if (! hash_equals($snapshot->payload_sha256, $digest)) {
            return ['valid' => false, 'reason' => 'payload digest mismatch'];
        }

        if (! hash_equals($snapshot->payload_canonical_json, $canonical)) {
            return ['valid' => false, 'reason' => 'stored canonical payload does not match recomputation'];
        }

        if (! AcademicEligibilitySigner::verify($canonical, $snapshot->signature)) {
            return ['valid' => false, 'reason' => 'signature verification failed'];
        }

        return ['valid' => true, 'reason' => 'ok'];
    }
}
