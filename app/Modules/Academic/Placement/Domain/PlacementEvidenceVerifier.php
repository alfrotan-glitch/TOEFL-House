<?php

declare(strict_types=1);

namespace App\Modules\Academic\Placement\Domain;

use App\Modules\Academic\Placement\Models\PlacementAttempt;
use App\Modules\Academic\Placement\Models\PlacementQuestion;
use App\Modules\Academic\Placement\Models\PlacementResponse;
use App\Modules\Academic\Placement\Models\PlacementSection;
use App\Modules\Academic\Placement\Models\PlacementRubric;
use App\Modules\Academic\Placement\Models\PlacementSectionResult;
use App\Support\Errors\BusinessRejection;

/**
 * Reads the immutable Placement evidence set before it is allowed to drive a
 * recommendation or release. A lifecycle label alone is never proof that an
 * attempt is intact: the HMAC must still bind the persisted response set,
 * physical evidence reference, and server-measured duration.
 */
final class PlacementEvidenceVerifier
{
    public function requireDecisionEligible(PlacementAttempt $attempt): void
    {
        if ($attempt->lineage_version !== PlacementAttempt::LINEAGE_VERSION) {
            throw BusinessRejection::forCode('placement.evidence_lineage_remediation_required', 'only post-convergence placement attempt evidence can support a new decision');
        }
        if ($attempt->status !== PlacementAttempt::STATUS_SUBMITTED) {
            throw BusinessRejection::forCode('placement.evidence_not_submitted', 'only a submitted placement attempt can support a decision');
        }
        if ((bool) $attempt->tamper_flagged) {
            throw BusinessRejection::forCode('placement.evidence_integrity_review_required', 'a tamper-flagged placement attempt cannot support a recommendation or release');
        }
        $duration = $attempt->duration_seconds;
        $hmac = trim((string) ($attempt->anti_tamper_hmac ?? ''));
        if ($duration === null || ! is_numeric($duration) || (int) $duration < 0 || preg_match('/^[0-9a-f]{64}$/', $hmac) !== 1) {
            throw BusinessRejection::forCode('placement.evidence_integrity_invalid', 'submitted placement evidence is missing a valid duration envelope or integrity HMAC');
        }

        $answers = [];
        foreach (PlacementResponse::query()
            ->where('attempt_id', $attempt->id)
            ->orderBy('question_id')
            ->get(['question_id', 'response_value', 'evidence_sha256']) as $response) {
            $questionId = trim((string) $response->question_id);
            $responseValue = (string) $response->response_value;
            $responseDigest = trim((string) ($response->evidence_sha256 ?? ''));
            if ($questionId === ''
                || array_key_exists($questionId, $answers)
                || preg_match('/^[0-9a-f]{64}$/', $responseDigest) !== 1
                || ! hash_equals(hash('sha256', $responseValue), $responseDigest)) {
                throw BusinessRejection::forCode('placement.evidence_integrity_invalid', 'placement response evidence is structurally invalid');
            }
            $answers[$questionId] = $responseValue;
        }
        $expectedQuestionIds = PlacementQuestion::query()
            ->whereIn('section_id', PlacementSection::query()
                ->where('test_version_id', $attempt->test_version_id)
                ->where('lifecycle_state', 'published')
                ->select('id'))
            ->where('lifecycle_state', 'published')
            ->pluck('id')
            ->map(static fn ($id): string => (string) $id)
            ->all();
        $actualQuestionIds = array_keys($answers);
        sort($expectedQuestionIds, SORT_STRING);
        sort($actualQuestionIds, SORT_STRING);
        if ($attempt->delivery_mode === 'digital' || $actualQuestionIds !== []) {
            if ($actualQuestionIds !== $expectedQuestionIds) {
                throw BusinessRejection::forCode('placement.evidence_integrity_invalid', 'normalized placement response evidence does not exactly match the immutable published question set');
            }
        } elseif ($attempt->evidence_ref === null || trim((string) $attempt->evidence_ref) === '') {
            throw BusinessRejection::forCode('placement.evidence_integrity_invalid', 'physical placement evidence without normalized answers requires a signed evidence reference');
        } elseif (PlacementSection::query()
            ->where('test_version_id', $attempt->test_version_id)
            ->where('lifecycle_state', 'published')
            ->where('can_auto_score', true)
            ->exists()) {
            throw BusinessRejection::forCode('placement.evidence_integrity_invalid', 'a physical attempt with auto-scored sections requires the exact normalized answer set');
        }

        if (! PlacementAntiTamper::verify(
            $attempt,
            $answers,
            $attempt->evidence_ref !== null ? (string) $attempt->evidence_ref : null,
            (int) $duration,
            $hmac,
        )) {
            throw BusinessRejection::forCode('placement.evidence_integrity_invalid', 'placement evidence no longer matches its server integrity HMAC');
        }
    }

    /**
     * A scored profile must have exactly the result set for its immutable test
     * version. Extra results are not harmless: they could alter component
     * averages, so they are rejected rather than ignored.
     */
    public function scoringIsComplete(PlacementAttempt $attempt): bool
    {
        if ($attempt->lineage_version !== PlacementAttempt::LINEAGE_VERSION
            || $attempt->status !== PlacementAttempt::STATUS_SUBMITTED) {
            return false;
        }

        /** @var \Illuminate\Support\Collection<string, PlacementSection> $sections */
        $sections = PlacementSection::query()
            ->where('test_version_id', $attempt->test_version_id)
            ->where('lifecycle_state', 'published')
            ->orderBy('id')
            ->get()
            ->keyBy('id');
        if ($sections->isEmpty()) {
            return false;
        }

        $results = PlacementSectionResult::query()
            ->where('attempt_id', $attempt->id)
            ->get();
        $actualSectionIds = $results
            ->pluck('section_id')
            ->map(static fn ($id): string => (string) $id)
            ->all();
        $expectedSectionIds = $sections->keys()->map(static fn ($id): string => (string) $id)->all();
        sort($expectedSectionIds, SORT_STRING);
        sort($actualSectionIds, SORT_STRING);
        if ($actualSectionIds !== $expectedSectionIds) {
            return false;
        }

        foreach ($results as $result) {
            /** @var PlacementSection|null $section */
            $section = $sections->get((string) $result->section_id);
            if ($section === null || $result->component !== $section->component || $result->raw_score === null) {
                return false;
            }
            if ($section->can_auto_score) {
                if ($result->scoring_method !== PlacementSectionResult::SCORING_METHOD_AUTOMATIC
                    || $result->weighted_score === null
                    || (float) $result->weighted_score < 0.0
                    || (float) $result->weighted_score > 100.0
                    || $result->rubric_id !== null
                    || $result->scored_by !== null) {
                    return false;
                }

                continue;
            }
            if ($result->scoring_method !== PlacementSectionResult::SCORING_METHOD_PROFESSIONAL
                || $result->rubric_id === null
                || $result->cefr_ref === null
                || $result->scored_by === null
                || (float) $result->raw_score < 0.0
                || (float) $result->raw_score > 100.0) {
                return false;
            }
            /** @var PlacementRubric|null $rubric */
            $rubric = PlacementRubric::query()->find($result->rubric_id);
            if ($rubric === null
                || $rubric->lifecycle_state !== 'published'
                || $rubric->test_version_id !== $attempt->test_version_id
                || $rubric->component !== $section->component
                || ! $rubric->containsScore((float) $result->raw_score)
                || strtoupper((string) $rubric->cefr_ref) !== strtoupper((string) $result->cefr_ref)) {
                return false;
            }
        }

        return true;
    }
}
