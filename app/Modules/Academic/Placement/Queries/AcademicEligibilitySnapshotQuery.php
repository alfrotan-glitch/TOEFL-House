<?php

declare(strict_types=1);

namespace App\Modules\Academic\Placement\Queries;

use App\Modules\Academic\Placement\Domain\AcademicEligibilitySnapshotBuilder;
use App\Modules\Academic\Placement\Domain\PlacementEvidenceVerifier;
use App\Modules\Academic\Placement\Models\AcademicEligibilitySnapshot;
use App\Modules\Academic\Placement\Models\PlacementAttempt;
use App\Modules\Academic\Placement\Models\PlacementProfile;
use App\Modules\Academic\Placement\Models\PlacementRecommendation;
use App\Modules\Academic\Placement\Models\PlacementSectionResult;
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
        $pointer = trim((string) ($profile->academic_eligibility_snapshot_id ?? ''));
        if ($pointer !== '') {
            /** @var AcademicEligibilitySnapshot|null $snapshot */
            $snapshot = AcademicEligibilitySnapshot::query()->find($pointer);
            if ($snapshot === null || trim((string) $snapshot->placement_profile_id) !== trim((string) $profile->id)) {
                return null;
            }

            return $this->present($snapshot);
        }

        // Pre-convergence records have no authoritative profile pointer.
        // Preserve their historical visibility, but never use this fallback
        // to produce a new decision or downstream consumption link.
        if ($profile->lineage_version === PlacementProfile::LINEAGE_VERSION) {
            return null;
        }
        $snapshot = AcademicEligibilitySnapshot::query()
            ->where('placement_profile_id', $profile->id)
            ->orderByDesc('version_no')
            ->first();

        return $snapshot === null ? null : $this->present($snapshot);
    }

    /** @return array<string, mixed>|null */
    public function byId(?string $snapshotId): ?array
    {
        $snapshotId = trim((string) ($snapshotId ?? ''));
        if ($snapshotId === '') {
            return null;
        }
        /** @var AcademicEligibilitySnapshot|null $snapshot */
        $snapshot = AcademicEligibilitySnapshot::query()->find($snapshotId);

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
                'signed_at' => $this->presentTimestamp($snapshot->signed_at),
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
        return array_values(AcademicEligibilitySnapshot::query()
            ->where('person_id', $personId)
            ->orderByDesc('signed_at')
            ->get()
            ->map(fn (AcademicEligibilitySnapshot $snapshot): array => $this->present($snapshot))
            ->all());
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

        $expectedKeyVersion = match ($snapshot->snapshot_schema_version) {
            AcademicEligibilitySnapshotBuilder::LEGACY_SCHEMA_VERSION => AcademicEligibilitySigner::LEGACY_KEY_VERSION,
            AcademicEligibilitySnapshotBuilder::SCHEMA_VERSION => AcademicEligibilitySigner::KEY_VERSION,
            default => null,
        };
        if ($expectedKeyVersion === null) {
            return ['valid' => false, 'reason' => 'unexpected snapshot schema version: '.$snapshot->snapshot_schema_version];
        }
        if ($snapshot->signing_key_version !== $expectedKeyVersion) {
            return ['valid' => false, 'reason' => 'unexpected signing key version for snapshot schema: '.$snapshot->signing_key_version];
        }

        try {
            $canonical = CanonicalJson::encode($snapshot->payload);
            $digest = hash('sha256', $canonical);
        } catch (\Throwable) {
            return ['valid' => false, 'reason' => 'payload cannot be canonically verified'];
        }

        if (! is_string($snapshot->payload_sha256) || ! hash_equals($snapshot->payload_sha256, $digest)) {
            return ['valid' => false, 'reason' => 'payload digest mismatch'];
        }

        if (! is_string($snapshot->payload_canonical_json) || ! hash_equals($snapshot->payload_canonical_json, $canonical)) {
            return ['valid' => false, 'reason' => 'stored canonical payload does not match recomputation'];
        }

        if (! AcademicEligibilitySigner::verify($canonical, (string) $snapshot->signature, (string) $snapshot->signing_key_version)) {
            return ['valid' => false, 'reason' => 'signature verification failed'];
        }

        $envelopeError = $this->payloadEnvelopeError($snapshot);
        if ($envelopeError !== null) {
            return ['valid' => false, 'reason' => $envelopeError];
        }

        return ['valid' => true, 'reason' => 'ok'];
    }

    private function payloadEnvelopeError(AcademicEligibilitySnapshot $snapshot): ?string
    {
        if ($snapshot->snapshot_schema_version !== AcademicEligibilitySnapshotBuilder::SCHEMA_VERSION) {
            // v1 rows predate exact attempt/recommendation lineage. Their
            // cryptographic payload remains verifiable for historical display,
            // but commands that create new cross-domain links reject them.
            return null;
        }

        $payload = $snapshot->payload;
        if (! is_array($payload)) {
            return 'snapshot payload is not an object';
        }
        $subject = $payload['subject'] ?? null;
        $placement = $payload['placement'] ?? null;
        $recommendationPayload = $payload['recommendation'] ?? null;
        $evidence = $payload['evidence'] ?? null;
        $attemptPayload = is_array($evidence) ? ($evidence['attempt'] ?? null) : null;
        $resultPayloads = is_array($evidence) ? ($evidence['section_results'] ?? null) : null;
        $snapshotPayload = $payload['snapshot'] ?? null;
        $signatureMaterial = $payload['signature_material'] ?? null;
        if (! is_array($subject) || ! is_array($placement) || ! is_array($recommendationPayload)
            || ! is_array($attemptPayload) || ! is_array($resultPayloads) || ! is_array($snapshotPayload)
            || ! is_array($signatureMaterial)) {
            return 'snapshot payload is missing its signed subject, decision, exact-attempt, result, or signature envelope';
        }

        $matches = [
            'schema version' => [$snapshotPayload['schema_version'] ?? null, $snapshot->snapshot_schema_version],
            'snapshot version number' => [$snapshotPayload['version_no'] ?? null, $snapshot->version_no],
            'snapshot signer' => [$snapshotPayload['signed_by'] ?? null, $snapshot->signed_by],
            'snapshot predecessor' => [$snapshotPayload['supersedes_snapshot_id'] ?? null, $snapshot->supersedes_snapshot_id],
            'subject person' => [$subject['person_id'] ?? null, $snapshot->person_id],
            'subject visitor' => [$subject['visitor_id'] ?? null, $snapshot->visitor_id],
            'subject originating branch' => [$subject['originating_branch_id'] ?? null, $snapshot->originating_branch_id],
            'subject current-home branch' => [$subject['current_home_branch_id'] ?? null, $snapshot->current_home_branch_id],
            'placement profile' => [$placement['placement_profile_id'] ?? null, $snapshot->placement_profile_id],
            'placement recommendation' => [$placement['recommendation_id'] ?? null, $snapshot->placement_recommendation_id],
            'placement exact attempt' => [$placement['attempt_id'] ?? null, $attemptPayload['id'] ?? null],
            'program version' => [$placement['program_version_id'] ?? null, $snapshot->program_version_id],
            'recommended level' => [$placement['recommended_level_id'] ?? null, $snapshot->recommended_level_id],
            'recommendation program version' => [$recommendationPayload['program_version_id'] ?? null, $snapshot->program_version_id],
            'recommendation level' => [$recommendationPayload['recommended_level_id'] ?? null, $snapshot->recommended_level_id],
            'signature algorithm' => [$signatureMaterial['algorithm'] ?? null, $snapshot->signature_algorithm],
            'signature key version' => [$signatureMaterial['key_version'] ?? null, $snapshot->signing_key_version],
            'signature contract' => [$signatureMaterial['contract'] ?? null, AcademicEligibilitySigner::CONTRACT],
        ];
        foreach ($matches as $label => [$payloadValue, $columnValue]) {
            if (! $this->sameSnapshotValue($payloadValue, $columnValue)) {
                return 'signed payload '.$label.' does not match the snapshot envelope';
            }
        }
        if (! $this->sameSnapshotTimestamp($snapshotPayload['signed_at'] ?? null, $snapshot->signed_at)) {
            return 'signed payload snapshot time does not match the snapshot envelope';
        }
        if ($snapshot->version_no !== 1
            || $snapshot->recommended_class_id !== null
            || $snapshot->recommended_offering_id !== null
            || $snapshot->academic_period_id !== null) {
            return 'v2 eligibility snapshots must carry only version-one level eligibility, not a Placement-owned class, offering, or academic-period assignment';
        }
        foreach ([$placement, $recommendationPayload, $payload['academic_context'] ?? []] as $part) {
            if (! is_array($part)) {
                return 'snapshot academic context is malformed';
            }
            foreach (['recommended_class_id', 'recommended_offering_id', 'academic_period_id'] as $forbidden) {
                if (array_key_exists($forbidden, $part) && $part[$forbidden] !== null) {
                    return 'v2 signed snapshot payload attempts to assign a class, offering, or academic period outside Enrollment/Scheduling authority';
                }
            }
        }

        /** @var PlacementProfile|null $profile */
        $profile = PlacementProfile::query()->find($snapshot->placement_profile_id);
        /** @var PlacementRecommendation|null $recommendation */
        $recommendation = PlacementRecommendation::query()->find($snapshot->placement_recommendation_id);
        $attemptId = $attemptPayload['id'] ?? null;
        /** @var PlacementAttempt|null $attempt */
        $attempt = is_string($attemptId) && trim($attemptId) !== '' ? PlacementAttempt::query()->find($attemptId) : null;
        if ($profile === null || $recommendation === null || $attempt === null
            || $profile->lineage_version !== PlacementProfile::LINEAGE_VERSION
            || ! in_array($profile->lifecycle_state, [
                PlacementProfile::STATE_RELEASED,
                PlacementProfile::STATE_SUPERSEDED,
                PlacementProfile::STATE_RETIRED,
            ], true)
            || ! $this->sameSnapshotValue($profile->person_id, $snapshot->person_id)
            || ! $this->sameSnapshotValue($profile->visitor_id, $snapshot->visitor_id)
            || ! $this->sameSnapshotValue($profile->originating_branch_id, $snapshot->originating_branch_id)
            || ! $this->sameSnapshotValue($profile->current_home_branch_id, $snapshot->current_home_branch_id)
            || ! $this->sameSnapshotValue($profile->program_version_id, $snapshot->program_version_id)
            || ! $this->sameSnapshotValue($profile->recommended_level_id, $snapshot->recommended_level_id)
            || ! $this->sameSnapshotValue($profile->academic_eligibility_snapshot_id, $snapshot->id)
            || ! $this->sameSnapshotValue($profile->placement_recommendation_id, $recommendation->id)
            || $recommendation->lineage_version !== PlacementRecommendation::LINEAGE_VERSION
            || ! $this->sameSnapshotValue($recommendation->profile_id, $profile->id)
            || ! $this->sameSnapshotValue($recommendation->attempt_id, $attempt->id)
            || ! $this->sameSnapshotValue($recommendation->program_version_id, $snapshot->program_version_id)
            || ! $this->sameSnapshotValue($recommendation->recommended_level_id, $snapshot->recommended_level_id)
            || $attempt->lineage_version !== PlacementAttempt::LINEAGE_VERSION
            || $attempt->status !== PlacementAttempt::STATUS_SUBMITTED
            || ! $this->sameSnapshotValue($attempt->profile_id, $profile->id)) {
            return 'snapshot database lineage no longer matches its signed exact recommendation and submitted attempt';
        }

        $attemptMatches = [
            'attempt id' => [$attemptPayload['id'] ?? null, $attempt->id],
            'attempt number' => [$attemptPayload['attempt_no'] ?? null, $attempt->attempt_no],
            'attempt test version' => [$attemptPayload['test_version_id'] ?? null, $attempt->test_version_id],
            'attempt delivery mode' => [$attemptPayload['delivery_mode'] ?? null, $attempt->delivery_mode],
            'attempt status' => [$attemptPayload['status'] ?? null, $attempt->status],
            'attempt duration' => [$attemptPayload['duration_seconds'] ?? null, $attempt->duration_seconds],
            'attempt HMAC' => [$attemptPayload['anti_tamper_hmac'] ?? null, $attempt->anti_tamper_hmac],
            'attempt tamper flag' => [$attemptPayload['tamper_flagged'] ?? null, (bool) $attempt->tamper_flagged],
        ];
        foreach ($attemptMatches as $label => [$payloadValue, $databaseValue]) {
            if (! $this->sameSnapshotValue($payloadValue, $databaseValue)) {
                return 'signed payload '.$label.' does not match its immutable attempt';
            }
        }
        if (! $this->sameSnapshotTimestamp($attemptPayload['started_at'] ?? null, $attempt->started_at)
            || ! $this->sameSnapshotTimestamp($attemptPayload['ended_at'] ?? null, $attempt->ended_at)) {
            return 'signed payload attempt time does not match its immutable attempt';
        }

        if (! $this->sameSnapshotValue($recommendationPayload['rationale'] ?? null, $recommendation->rationale)
            || ! $this->sameSnapshotValue($recommendationPayload['model_version'] ?? null, $recommendation->model_version)
            || ! $this->sameCanonicalValue($recommendationPayload['score_snapshot'] ?? null, $recommendation->score_snapshot)
            || ! $this->sameSnapshotValue($profile->overall_cefr_ref, is_array($recommendation->score_snapshot) ? ($recommendation->score_snapshot['overall_cefr'] ?? null) : null)) {
            return 'signed payload recommendation details do not match the immutable recommendation';
        }

        try {
            $evidenceVerifier = new PlacementEvidenceVerifier;
            $evidenceVerifier->requireDecisionEligible($attempt);
            if (! $evidenceVerifier->scoringIsComplete($attempt)) {
                return 'snapshot exact attempt no longer has a complete structurally valid score set';
            }
        } catch (\Throwable) {
            return 'snapshot exact attempt no longer passes placement evidence verification';
        }
        if (PlacementSectionResult::query()
            ->where('attempt_id', $attempt->id)
            ->where('lifecycle_state', '!=', PlacementSectionResult::STATE_APPROVED)
            ->exists()) {
            return 'snapshot exact attempt contains an unapproved section result';
        }
        if (($resultError = $this->sectionResultPayloadError($resultPayloads, $attempt->id)) !== null) {
            return $resultError;
        }

        return null;
    }

    /** @param array<mixed> $resultPayloads */
    private function sectionResultPayloadError(array $resultPayloads, string $attemptId): ?string
    {
        /** @var array<string, PlacementSectionResult> $results */
        $results = PlacementSectionResult::query()
            ->where('attempt_id', $attemptId)
            ->get()
            ->keyBy('id')
            ->all();
        if (count($resultPayloads) !== count($results)) {
            return 'signed payload section result count does not match the exact attempt';
        }
        $seen = [];
        foreach ($resultPayloads as $resultPayload) {
            if (! is_array($resultPayload)) {
                return 'signed payload section result is malformed';
            }
            $id = $resultPayload['id'] ?? null;
            if (! is_string($id) || $id === '' || isset($seen[$id]) || ! isset($results[$id])) {
                return 'signed payload section result does not identify each exact result once';
            }
            $seen[$id] = true;
            $result = $results[$id];
            $matches = [
                'section id' => [$resultPayload['section_id'] ?? null, $result->section_id],
                'component' => [$resultPayload['component'] ?? null, $result->component],
                'raw score' => [$resultPayload['raw_score'] ?? null, $result->raw_score],
                'adjusted score' => [$resultPayload['adjusted_score'] ?? null, $result->adjusted_score],
                'weighted score' => [$resultPayload['weighted_score'] ?? null, $result->weighted_score],
                'rubric id' => [$resultPayload['rubric_id'] ?? null, $result->rubric_id],
                'CEFR reference' => [$resultPayload['cefr_ref'] ?? null, $result->cefr_ref],
                'lifecycle state' => [$resultPayload['lifecycle_state'] ?? null, $result->lifecycle_state],
                'scoring method' => [$resultPayload['scoring_method'] ?? null, $result->scoring_method],
                'scored by' => [$resultPayload['scored_by'] ?? null, $result->scored_by],
                'moderated by' => [$resultPayload['moderated_by'] ?? null, $result->moderated_by],
                'approved by' => [$resultPayload['approved_by'] ?? null, $result->approved_by],
            ];
            foreach ($matches as $label => [$payloadValue, $databaseValue]) {
                if (! $this->sameSnapshotValue($payloadValue, $databaseValue)) {
                    return 'signed payload section result '.$label.' does not match the immutable scored result';
                }
            }
        }

        return count($seen) === count($results) ? null : 'signed payload section results are incomplete';
    }

    private function presentTimestamp(mixed $value): ?string
    {
        if ($value === null) {
            return null;
        }
        try {
            return Carbon::parse((string) $value)->toIso8601String();
        } catch (\Throwable) {
            return null;
        }
    }

    private function sameSnapshotValue(mixed $payloadValue, mixed $databaseValue): bool
    {
        if ($payloadValue === null || $databaseValue === null) {
            return $payloadValue === null && $databaseValue === null;
        }
        if (is_bool($payloadValue) || is_bool($databaseValue)) {
            return is_bool($payloadValue) && is_bool($databaseValue) && $payloadValue === $databaseValue;
        }

        return (string) $payloadValue === (string) $databaseValue;
    }

    private function sameSnapshotTimestamp(mixed $payloadValue, mixed $databaseValue): bool
    {
        if ($payloadValue === null || $databaseValue === null) {
            return $payloadValue === null && $databaseValue === null;
        }
        try {
            return Carbon::parse((string) $payloadValue)->equalTo(Carbon::parse((string) $databaseValue));
        } catch (\Throwable) {
            return false;
        }
    }

    private function sameCanonicalValue(mixed $left, mixed $right): bool
    {
        try {
            return CanonicalJson::encode($left) === CanonicalJson::encode($right);
        } catch (\Throwable) {
            return false;
        }
    }

}
