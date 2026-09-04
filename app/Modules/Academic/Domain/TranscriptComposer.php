<?php

declare(strict_types=1);

namespace App\Modules\Academic\Domain;

use App\Modules\Academic\Models\AcademicPeriod;
use App\Modules\Academic\Models\AssessmentAttempt;
use App\Modules\Academic\Models\AssessmentResult;
use App\Modules\Academic\Models\AttendanceFact;
use App\Modules\Academic\Models\Certificate;
use App\Modules\Academic\Models\ClassModel;
use App\Modules\Academic\Models\ClassSession;
use App\Modules\Academic\Models\Enrollment;
use App\Modules\Academic\Models\LevelProgressFact;
use App\Modules\Academic\Models\Program;
use App\Modules\Academic\Models\ProgramVersion;
use App\Modules\Academic\Models\ProgramVersionLevel;
use App\Modules\Academic\Placement\Models\AcademicEligibilitySnapshot;
use App\Modules\Academic\Queries\GraduationCertificationQuery;
use App\Modules\Students\Models\Student;
use Illuminate\Support\Collection;

/**
 * Composes the official transcript content from immutable Academic facts.
 * Pure read: level progress facts, current released results, terminal and
 * in-progress seats, latest-per-session attendance totals, the entry
 * placement snapshot, and graduation output. Display names are pinned as
 * text so later renames cannot rewrite issued history. The caller
 * (IssueTranscript) wraps these sections with the issuance header, freezes
 * the canonical payload, and hashes it.
 */
final class TranscriptComposer
{
    public function __construct(private readonly GraduationCertificationQuery $certification) {}

    /** @return array<string, mixed> */
    public function compose(string $studentId, string $programVersionId): array
    {
        /** @var Student $student */
        $student = Student::query()->findOrFail($studentId);
        /** @var ProgramVersion $version */
        $version = ProgramVersion::query()->findOrFail($programVersionId);
        /** @var Program|null $program */
        $program = Program::query()->find($version->program_id);

        $classIds = ClassModel::query()->where('program_version_id', $programVersionId)->pluck('id')->all();
        /** @var list<string> $classIds */
        $classIds = array_map(strval(...), $classIds);

        $enrollments = Enrollment::query()->where('student_id', $studentId)->whereIn('class_id', $classIds)->orderBy('created_at')->get();

        return [
            'student' => [
                'student_id' => $student->id,
                'student_code' => $student->student_code,
                'legal_name' => $student->person?->legal_name,
            ],
            'program' => [
                'program_version_id' => $version->id,
                'program_name' => $program?->name,
                'version_summary' => $version->summary,
            ],
            'entry' => $this->entry((string) $student->person_id, $programVersionId),
            'levels' => $this->levels($studentId, $programVersionId),
            'results' => $this->results($enrollments->all()),
            'seats' => $this->seats($enrollments->all()),
            'attendance' => $this->attendance($enrollments->all()),
            'graduation' => $this->graduation($studentId),
        ];
    }

    /** @return array<string, mixed>|null */
    private function entry(string $personId, string $programVersionId): ?array
    {
        /** @var AcademicEligibilitySnapshot|null $snapshot */
        $snapshot = AcademicEligibilitySnapshot::query()
            ->where('person_id', $personId)
            ->where('program_version_id', $programVersionId)
            ->orderByDesc('signed_at')
            ->first();
        if ($snapshot === null) {
            return null;
        }

        return [
            'snapshot_id' => $snapshot->id,
            'recommended_level' => $this->levelText($snapshot->recommended_level_id),
            'payload_digest' => $snapshot->payload_sha256,
            'signed_at' => $snapshot->signed_at?->toIso8601String(),
        ];
    }

    /** @return list<array<string, mixed>> */
    private function levels(string $studentId, string $programVersionId): array
    {
        return LevelProgressFact::query()
            ->where('student_id', $studentId)
            ->where('program_version_id', $programVersionId)
            ->orderBy('achieved_at')
            ->get()
            ->map(function (LevelProgressFact $fact): array {
                /** @var AssessmentResult|null $result */
                $result = $fact->assessment_result_id !== null ? AssessmentResult::query()->find($fact->assessment_result_id) : null;

                return [
                    'fact_id' => $fact->id,
                    'level' => $this->levelText($fact->level_id),
                    'to_level' => $fact->to_level_id !== null ? $this->levelText($fact->to_level_id) : null,
                    'class_id' => (string) $fact->class_id,
                    'period' => $this->periodText($fact->class_id),
                    'outcome' => $fact->outcome,
                    'repeat_count' => (int) $fact->repeat_count,
                    'decision_id' => (string) $fact->decision_id,
                    'result_score' => $result !== null ? (string) $result->score : null,
                    'achieved_at' => $fact->achieved_at?->toIso8601String(),
                ];
            })
            ->all();
    }

    /**
     * @param  list<Enrollment>  $enrollments
     * @return list<array<string, mixed>>
     */
    private function results(array $enrollments): array
    {
        $rows = [];
        foreach ($enrollments as $enrollment) {
            $attempts = AssessmentAttempt::query()->where('enrollment_id', $enrollment->id)->orderBy('created_at')->get();
            foreach ($attempts as $attempt) {
                /** @var AssessmentResult|null $current */
                $current = AssessmentResult::query()
                    ->where('attempt_id', $attempt->id)
                    ->where('lifecycle_state', '!=', AssessmentResultLifecycle::STATE_CORRECTED)
                    ->orderByDesc('created_at')
                    ->orderByDesc('id')
                    ->first();
                if ($current === null || $current->lifecycle_state !== AssessmentResultLifecycle::STATE_RELEASED) {
                    continue;
                }
                $rows[] = [
                    'result_id' => $current->id,
                    'enrollment_id' => (string) $enrollment->id,
                    'attempt_id' => (string) $attempt->id,
                    'attempt_kind' => $attempt->kind,
                    'score' => (string) $current->score,
                ];
            }
        }

        return $rows;
    }

    /**
     * @param  list<Enrollment>  $enrollments
     * @return array{completed: list<array<string, mixed>>, in_progress: list<array<string, mixed>>}
     */
    private function seats(array $enrollments): array
    {
        $completed = [];
        $inProgress = [];
        foreach ($enrollments as $enrollment) {
            $row = [
                'enrollment_id' => $enrollment->id,
                'class_id' => (string) $enrollment->class_id,
                'period' => $this->periodText($enrollment->class_id),
                'state' => $enrollment->lifecycle_state,
            ];
            if ($enrollment->lifecycle_state === EnrollmentLifecycle::STATE_COMPLETED) {
                $row['completion_basis'] = $enrollment->completion_basis;
                $row['completion_evidence_kind'] = $enrollment->completion_evidence_kind;
                $completed[] = $row;
            } elseif (in_array($enrollment->lifecycle_state, [EnrollmentLifecycle::STATE_TRANSFERRED, EnrollmentLifecycle::STATE_WITHDRAWN], true)) {
                $completed[] = $row;
            } else {
                $inProgress[] = $row;
            }
        }

        return ['completed' => $completed, 'in_progress' => $inProgress];
    }

    /**
     * @param  list<Enrollment>  $enrollments
     * @return list<array<string, mixed>>
     */
    private function attendance(array $enrollments): array
    {
        $rows = [];
        foreach ($enrollments as $enrollment) {
            $sessionIds = ClassSession::query()->where('class_id', $enrollment->class_id)->pluck('id')->all();
            if ($sessionIds === []) {
                continue;
            }
            // A correction supersedes its original by reference (corrects_id),
            // never by timestamp: created_at has only second precision, so
            // two facts in the same second have no reliable time order.
            /** @var Collection<int, AttendanceFact> $facts */
            $facts = AttendanceFact::query()
                ->where('enrollment_id', $enrollment->id)
                ->whereIn('session_id', $sessionIds)
                ->get();
            $superseded = [];
            foreach ($facts as $fact) {
                if ($fact->corrects_id !== null && $fact->corrects_id !== '') {
                    $superseded[(string) $fact->corrects_id] = true;
                }
            }
            $latest = [];
            foreach ($facts as $fact) {
                if (isset($superseded[(string) $fact->id])) {
                    continue;
                }
                $latest[(string) $fact->session_id] ??= (string) $fact->status;
            }
            $counts = array_count_values($latest);
            $rows[] = [
                'enrollment_id' => $enrollment->id,
                'sessions' => count($sessionIds),
                'marked' => count($latest),
                'present' => $counts['present'] ?? 0,
                'absent' => $counts['absent'] ?? 0,
                'late' => $counts['late'] ?? 0,
                'excused' => $counts['excused'] ?? 0,
            ];
        }

        return $rows;
    }

    /** @return array<string, mixed>|null */
    private function graduation(string $studentId): ?array
    {
        $certification = $this->certification->certificationForStudent($studentId);
        if ($certification === null) {
            return null;
        }
        /** @var Certificate|null $certificate */
        $certificate = $certification['certificate_id'] !== null ? Certificate::query()->find($certification['certificate_id']) : null;

        return [
            'decision_id' => $certification['decision_id'],
            'certificate_serial' => $certificate?->serial,
            'certificate_document_id' => $certification['document_id'],
        ];
    }

    /** @return array<string, mixed>|null */
    private function levelText(?string $levelId): ?array
    {
        if ($levelId === null || $levelId === '') {
            return null;
        }
        /** @var ProgramVersionLevel|null $level */
        $level = ProgramVersionLevel::query()->find($levelId);
        if ($level === null) {
            return null;
        }

        return [
            'level_id' => $level->id,
            'level_key' => $level->level_key,
            'ordinal' => (int) $level->ordinal,
            'title' => $level->title,
            'cefr_ref' => $level->cefr_ref,
        ];
    }

    /** @return array<string, mixed>|null */
    private function periodText(string $classId): ?array
    {
        /** @var ClassModel|null $class */
        $class = ClassModel::query()->find($classId);
        if ($class === null) {
            return null;
        }
        /** @var AcademicPeriod|null $period */
        $period = AcademicPeriod::query()->find($class->period_id);
        if ($period === null) {
            return null;
        }

        return [
            'period_id' => $period->id,
            'name' => $period->name,
            'starts_on' => $period->starts_on,
            'ends_on' => $period->ends_on,
        ];
    }
}
