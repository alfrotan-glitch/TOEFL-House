<?php

declare(strict_types=1);

namespace App\Modules\Academic\Domain;

use App\Modules\Academic\Models\AcademicAppeal;
use App\Modules\Academic\Models\AssessmentAttempt;
use App\Modules\Academic\Models\AssessmentResult;
use App\Modules\Academic\Models\Certificate;
use App\Modules\Academic\Models\ClassWaitlistEntry;
use App\Modules\Academic\Models\Enrollment;
use App\Modules\Academic\Models\GraduationDecision;
use App\Modules\Academic\Models\Offering;
use App\Modules\Academic\Models\ProgressionDecision;
use App\Modules\Academic\Models\Transcript;
use App\Modules\Academic\Placement\Models\PlacementProfile;
use App\Modules\Students\Models\Student;

/**
 * Branch derivation for Academic targets (WP-ACAD-SCOPE). First hit wins;
 * stored provenance beats live derivation; nothing is fabricated — every
 * step reads a linked row, and unknown provenance resolves to null (global
 * check) rather than a guessed branch. All identifiers are trimmed: branch
 * columns are fixed-width char.
 */
final class RecordBranch
{
    public static function studentBranch(?Student $student): ?string
    {
        if ($student === null) {
            return null;
        }

        return self::present($student->current_home_branch_id) ?? self::present($student->originating_branch_id);
    }

    public static function studentBranchForId(?string $studentId): ?string
    {
        $studentId = trim((string) ($studentId ?? ''));
        if ($studentId === '') {
            return null;
        }

        return self::studentBranch(Student::query()->find($studentId));
    }

    public static function enrollmentBranch(Enrollment $enrollment): ?string
    {
        return self::present($enrollment->current_home_branch_id)
            ?? self::present($enrollment->originating_branch_id)
            ?? self::offeringBranch($enrollment->offering_id)
            ?? self::studentBranchForId((string) $enrollment->student_id);
    }

    public static function attemptBranch(AssessmentAttempt $attempt): ?string
    {
        /** @var Enrollment|null $enrollment */
        $enrollment = Enrollment::query()->find($attempt->enrollment_id);

        return $enrollment === null ? null : self::enrollmentBranch($enrollment);
    }

    public static function resultBranch(AssessmentResult $result): ?string
    {
        /** @var AssessmentAttempt|null $attempt */
        $attempt = AssessmentAttempt::query()->find($result->attempt_id);

        return $attempt === null ? null : self::attemptBranch($attempt);
    }

    public static function waitlistBranch(ClassWaitlistEntry $entry): ?string
    {
        return self::offeringBranch($entry->offering_id)
            ?? self::studentBranchForId((string) $entry->student_id);
    }

    public static function progressionBranch(ProgressionDecision $decision): ?string
    {
        return self::studentBranchForId((string) $decision->student_id);
    }

    public static function graduationBranch(GraduationDecision $decision): ?string
    {
        return self::studentBranchForId((string) $decision->student_id);
    }

    public static function transcriptBranch(Transcript $transcript): ?string
    {
        return self::studentBranchForId((string) $transcript->student_id);
    }

    public static function certificateBranch(Certificate $certificate): ?string
    {
        return self::present($certificate->current_home_branch_id)
            ?? self::present($certificate->originating_branch_id)
            ?? self::studentBranchForId((string) $certificate->student_id);
    }

    public static function placementProfileBranch(?PlacementProfile $profile): ?string
    {
        if ($profile === null) {
            return null;
        }

        return self::present($profile->current_home_branch_id)
            ?? self::present($profile->originating_branch_id);
    }

    /**
     * Branch of an appeal's contested subject. A missing subject row
     * resolves to null (recoverability over lockout — subject rows are
     * lifecycle-only and never deleted; see WP-ACAD-APPEAL-RESOLVE).
     */
    public static function appealBranch(AcademicAppeal $appeal): ?string
    {
        return self::appealSubjectBranch((string) $appeal->subject_type, (string) $appeal->subject_id);
    }

    public static function appealSubjectBranch(string $subjectType, string $subjectId): ?string
    {
        $subjectId = trim($subjectId);
        if ($subjectId === '') {
            return null;
        }
        if ($subjectType === 'assessment_result') {
            /** @var AssessmentResult|null $result */
            $result = AssessmentResult::query()->find($subjectId);

            return $result === null ? null : self::resultBranch($result);
        }
        if ($subjectType === 'progression_decision') {
            /** @var ProgressionDecision|null $decision */
            $decision = ProgressionDecision::query()->find($subjectId);

            return $decision === null ? null : self::progressionBranch($decision);
        }
        if ($subjectType === 'placement_profile') {
            /** @var PlacementProfile|null $profile */
            $profile = PlacementProfile::query()->find($subjectId);

            return self::placementProfileBranch($profile);
        }

        return null;
    }

    /**
     * Owning student of an appeal subject, for the filing-time binding check
     * (WP-ACAD-APPEAL-RESOLVE). Placement subjects resolve through the
     * profile's person and may legitimately have no student row (pre-Student).
     */
    public static function subjectStudentId(string $subjectType, string $subjectId): ?string
    {
        $subjectId = trim($subjectId);
        if ($subjectId === '') {
            return null;
        }
        if ($subjectType === 'assessment_result') {
            /** @var AssessmentResult|null $result */
            $result = AssessmentResult::query()->find($subjectId);
            if ($result === null) {
                return null;
            }
            /** @var AssessmentAttempt|null $attempt */
            $attempt = AssessmentAttempt::query()->find($result->attempt_id);
            if ($attempt === null) {
                return null;
            }
            /** @var Enrollment|null $enrollment */
            $enrollment = Enrollment::query()->find($attempt->enrollment_id);

            return $enrollment === null ? null : self::present($enrollment->student_id);
        }
        if ($subjectType === 'progression_decision') {
            /** @var ProgressionDecision|null $decision */
            $decision = ProgressionDecision::query()->find($subjectId);

            return $decision === null ? null : self::present($decision->student_id);
        }
        if ($subjectType === 'placement_profile') {
            /** @var PlacementProfile|null $profile */
            $profile = PlacementProfile::query()->find($subjectId);
            if ($profile === null) {
                return null;
            }

            return self::present(Student::query()->where('person_id', $profile->person_id)->value('id'));
        }

        return null;
    }

    private static function offeringBranch(?string $offeringId): ?string
    {
        $offeringId = trim((string) ($offeringId ?? ''));
        if ($offeringId === '') {
            return null;
        }
        /** @var Offering|null $offering */
        $offering = Offering::query()->find($offeringId);

        return $offering === null ? null : self::present($offering->branch_id);
    }

    private static function present(mixed $value): ?string
    {
        $trimmed = trim((string) ($value ?? ''));

        return $trimmed === '' ? null : $trimmed;
    }
}
