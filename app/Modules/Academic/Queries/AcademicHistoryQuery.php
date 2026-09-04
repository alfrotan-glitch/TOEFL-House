<?php

declare(strict_types=1);

namespace App\Modules\Academic\Queries;

use App\Modules\Academic\Models\LevelPrerequisite;
use App\Modules\Academic\Models\LevelProgressFact;
use App\Modules\Academic\Models\ProgramVersionLevel;
use App\Modules\Academic\Placement\Models\AcademicEligibilitySnapshot;
use App\Modules\Students\Models\Student;

/**
 * Read-only academic history / level projection (ADR-018).
 *
 * Academic history is immutable `level_progress_facts`; current level is the
 * latest approved fact's target (or the released placement recommendation
 * when no fact exists). This is a projection for Student/Placement/Enrollment/
 * Reporting/Documents/Finance validation — it never decides status and never
 * becomes financial truth.
 */
final class AcademicHistoryQuery
{
    /**
     * @return list<array<string, mixed>>
     */
    public function historyForStudent(string $studentId, ?string $programVersionId = null): array
    {
        $query = LevelProgressFact::query()
            ->with(['level', 'toLevel'])
            ->where('student_id', $studentId)
            ->orderByDesc('achieved_at');

        if ($programVersionId !== null && $programVersionId !== '') {
            $query->where('program_version_id', $programVersionId);
        }

        return $query->get()
            ->map(fn (LevelProgressFact $fact): array => [
                'fact_id' => $fact->id,
                'program_version_id' => (string) $fact->program_version_id,
                'level_id' => (string) $fact->level_id,
                'to_level_id' => $fact->to_level_id !== null ? (string) $fact->to_level_id : null,
                'class_id' => (string) $fact->class_id,
                'offering_id' => $fact->offering_id !== null ? (string) $fact->offering_id : null,
                'academic_period_id' => (string) $fact->academic_period_id,
                'decision_id' => (string) $fact->decision_id,
                'assessment_result_id' => $fact->assessment_result_id !== null ? (string) $fact->assessment_result_id : null,
                'outcome' => $fact->outcome,
                'repeat_count' => (int) $fact->repeat_count,
                'achieved_at' => $fact->achieved_at?->toIso8601String(),
            ])
            ->all();
    }

    public function currentLevel(string $studentId, ?string $programVersionId = null): ?ProgramVersionLevel
    {
        $fact = LevelProgressFact::query()
            ->where('student_id', $studentId)
            ->when($programVersionId !== null && $programVersionId !== '', fn ($query) => $query->where('program_version_id', $programVersionId))
            ->orderByDesc('achieved_at')
            ->first();

        if ($fact !== null) {
            if ($fact->outcome === LevelProgressFact::OUTCOME_ADVANCE && $fact->to_level_id !== null) {
                return ProgramVersionLevel::query()->find($fact->to_level_id);
            }

            return ProgramVersionLevel::query()->find($fact->level_id);
        }

        /** @var Student|null $student */
        $student = Student::query()->find($studentId);
        if ($student === null) {
            return null;
        }

        $snapshot = AcademicEligibilitySnapshot::query()
            ->where('person_id', (string) $student->person_id)
            ->when($programVersionId !== null && $programVersionId !== '', fn ($query) => $query->where('program_version_id', $programVersionId))
            ->whereNotNull('recommended_level_id')
            ->orderByDesc('signed_at')
            ->first();

        if ($snapshot === null) {
            return null;
        }

        return ProgramVersionLevel::query()->find($snapshot->recommended_level_id);
    }

    /**
     * @return list<array{required_level_id: string, level_key: string, ordinal: int, evidence: string}>
     */
    public function prerequisiteViolations(string $studentId, ProgramVersionLevel $targetLevel): array
    {
        $prerequisites = LevelPrerequisite::query()
            ->with('requiredLevel')
            ->where('target_level_id', $targetLevel->id)
            ->where('lifecycle_state', LevelPrerequisite::STATE_ACTIVE)
            ->get();

        /** @var Student|null $student */
        $student = Student::query()->find($studentId);
        if ($student === null) {
            return $prerequisites->map(fn (LevelPrerequisite $p): array => $this->violation($p, 'unknown_student'))->all();
        }

        $snapshot = AcademicEligibilitySnapshot::query()
            ->where('person_id', (string) $student->person_id)
            ->whereNotNull('recommended_level_id')
            ->orderByDesc('signed_at')
            ->first();
        $snapshotOverride = $snapshot?->recommended_level_id !== null && $this->snapshotCoversTarget($snapshot->recommended_level_id, $targetLevel);

        $violations = [];
        foreach ($prerequisites as $prerequisite) {
            if ($snapshotOverride) {
                continue;
            }
            $satisfied = LevelProgressFact::query()
                ->where('student_id', $studentId)
                ->where('program_version_id', (string) $targetLevel->program_version_id)
                ->where('level_id', $prerequisite->required_level_id)
                ->where('outcome', LevelProgressFact::OUTCOME_ADVANCE)
                ->exists();

            if (! $satisfied) {
                $violations[] = $this->violation($prerequisite, 'missing_advance');
            }
        }

        return $violations;
    }

    /** @return array{required_level_id: string, level_key: string, ordinal: int, evidence: string} */
    private function violation(LevelPrerequisite $prerequisite, string $evidence): array
    {
        $required = $prerequisite->requiredLevel;

        return [
            'required_level_id' => (string) $prerequisite->required_level_id,
            'level_key' => $required !== null ? $required->level_key : '',
            'ordinal' => $required !== null ? $required->ordinal : 0,
            'evidence' => $evidence,
        ];
    }

    private function snapshotCoversTarget(string $recommendedLevelId, ProgramVersionLevel $targetLevel): bool
    {
        $recommended = ProgramVersionLevel::query()->find($recommendedLevelId);
        if ($recommended === null) {
            return false;
        }

        return (string) $recommended->program_version_id === (string) $targetLevel->program_version_id
            && (int) $recommended->ordinal >= (int) $targetLevel->ordinal;
    }
}
