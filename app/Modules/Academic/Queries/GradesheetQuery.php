<?php

declare(strict_types=1);

namespace App\Modules\Academic\Queries;

use App\Modules\Academic\Commands\ManageAssessmentResult;
use App\Modules\Academic\Domain\AssessmentResultLifecycle;
use App\Modules\Academic\Models\AcademicPeriod;
use App\Modules\Academic\Models\AssessmentAttempt;
use App\Modules\Academic\Models\AssessmentResult;
use App\Modules\Academic\Models\ClassModel;
use App\Modules\Academic\Models\Enrollment;
use App\Modules\Academic\Models\ResultCorrection;
use App\Modules\Academic\Models\TeacherAssignment;
use App\Modules\Audit\AttemptedOperation;
use App\Modules\Students\Models\Student;
use App\Support\Authorization\AccessDecision;
use App\Support\Authorization\Actor;
use App\Support\Errors\AuthorizationDenied;
use Carbon\CarbonImmutable;
use Illuminate\Support\Collection;

/**
 * Per-class grade compilation over the certified assessment result chain.
 *
 * This query never writes: every mutation stays on ManageAssessmentResult
 * (submit/score/moderate/approve/release, staged corrections). It compiles
 * one class's roster × attempts × live result × correction lineage, and it
 * enforces the viewer rule: an open-assigned teacher of the class
 * (identity match), a teacher whose assignment ended while the class
 * period has not ended (D-F-058/D-F-066 read-only tier — the page itself
 * is read-only and the rule never grants mutation authority), or academic
 * oversight (a chain or structure capability). Denials are audited exactly
 * like command denials.
 */
final class GradesheetQuery
{
    /**
     * Capabilities whose holders may open any class gradesheet as academic
     * oversight. The chain capabilities come from ManageAssessmentResult;
     * 'academic.structure' covers branch/level/offering officers.
     *
     * @var list<string>
     */
    private const OVERSIGHT_CAPABILITIES = [
        ManageAssessmentResult::CAPABILITY_ASSESS,
        ManageAssessmentResult::CAPABILITY_MODERATE,
        ManageAssessmentResult::CAPABILITY_APPROVE,
        ManageAssessmentResult::CAPABILITY_RELEASE,
        'academic.structure',
    ];

    public function __construct(
        private readonly AccessDecision $access,
        private readonly AttemptedOperation $attemptedOperation,
    ) {}

    /**
     * Classes the viewer may open, for scoping the gradesheet selector.
     * Open-assigned classes plus ended-assignment classes whose period
     * has not ended, for teachers; recent classes for oversight.
     *
     * @return Collection<int, ClassModel>
     */
    public function accessibleClasses(Actor $actor): Collection
    {
        if ($this->isOversight($actor)) {
            /** @var Collection<int, ClassModel> $classes */
            $classes = ClassModel::query()->orderByDesc('created_at')->limit(100)->get();

            return $classes;
        }

        $classIds = TeacherAssignment::query()
            ->where('teacher_person_id', $actor->actorId)
            ->distinct()
            ->pluck('class_id')
            ->all();

        if ($classIds === []) {
            return new Collection;
        }

        /** @var Collection<int, ClassModel> $classes */
        $classes = ClassModel::query()->whereIn('id', $classIds)->orderByDesc('created_at')->get();

        return $classes->filter(fn (ClassModel $class): bool => $this->mayView($actor, $class))->values();
    }

    /**
     * Compile the gradesheet for one class.
     *
     * @return array<string, mixed>
     */
    public function forClass(Actor $actor, ClassModel $class): array
    {
        $this->requireViewer($actor, $class);

        $teachers = TeacherAssignment::query()
            ->where('class_id', $class->id)
            ->orderBy('effective_from')
            ->get()
            ->map(fn (TeacherAssignment $assignment): array => [
                'assignment_id' => (string) $assignment->id,
                'teacher_person_id' => (string) $assignment->teacher_person_id,
                'effective_from' => (string) $assignment->effective_from,
                'effective_to' => $assignment->effective_to !== null ? (string) $assignment->effective_to : null,
            ])
            ->all();

        /** @var Collection<int, Enrollment> $seats */
        $seats = Enrollment::query()
            ->where('class_id', $class->id)
            ->where('lifecycle_state', '!=', 'requested')
            ->orderBy('created_at')
            ->get();

        $students = Student::query()
            ->whereIn('id', $seats->map(fn (Enrollment $seat): string => (string) $seat->student_id)->all())
            ->with('person')
            ->get()
            ->keyBy(fn (Student $student): string => (string) $student->id);

        $attemptsBySeat = AssessmentAttempt::query()
            ->whereIn('enrollment_id', $seats->map(fn (Enrollment $seat): string => (string) $seat->id)->all())
            ->orderBy('created_at')
            ->get()
            ->groupBy(fn (AssessmentAttempt $attempt): string => (string) $attempt->enrollment_id);

        $attemptIds = $attemptsBySeat->flatten()->map(fn (AssessmentAttempt $attempt): string => (string) $attempt->id)->all();

        $resultsByAttempt = $attemptIds === []
            ? new Collection
            : AssessmentResult::query()
                ->whereIn('attempt_id', $attemptIds)
                ->orderBy('created_at')
                ->orderBy('id')
                ->get()
                ->groupBy(fn (AssessmentResult $result): string => (string) $result->attempt_id);

        $resultIds = $resultsByAttempt->flatten()->map(fn (AssessmentResult $result): string => (string) $result->id)->all();

        $openCorrections = $resultIds === []
            ? new Collection
            : ResultCorrection::query()
                ->whereIn('result_id', $resultIds)
                ->where('lifecycle_state', ResultCorrection::STATE_PROPOSED)
                ->get()
                ->keyBy(fn (ResultCorrection $correction): string => (string) $correction->result_id);

        $rows = $seats->map(function (Enrollment $seat) use ($students, $attemptsBySeat, $resultsByAttempt, $openCorrections): array {
            $student = $students->get((string) $seat->student_id);

            return [
                'enrollment_id' => (string) $seat->id,
                'student_id' => (string) $seat->student_id,
                'student_code' => $student?->student_code,
                'legal_name' => $student?->person?->legal_name,
                'lifecycle_state' => $seat->lifecycle_state,
                'attempts' => $attemptsBySeat->get((string) $seat->id, new Collection)->map(
                    fn (AssessmentAttempt $attempt): array => $this->attemptRow($attempt, $resultsByAttempt, $openCorrections)
                )->all(),
            ];
        })->all();

        return [
            'class' => [
                'id' => (string) $class->id,
                'lifecycle_state' => $class->lifecycle_state,
                'capacity' => (int) $class->capacity,
                'program_version_id' => (string) $class->program_version_id,
                'period_id' => (string) $class->period_id,
                'program_version_level_id' => $class->program_version_level_id !== null ? (string) $class->program_version_level_id : null,
            ],
            'teachers' => $teachers,
            'seats' => $rows,
        ];
    }

    private function requireViewer(Actor $actor, ClassModel $class): void
    {
        if ($this->mayView($actor, $class) || $this->isOversight($actor)) {
            return;
        }

        try {
            throw AuthorizationDenied::forCode(
                'academic.gradesheet_denied',
                'only an assigned teacher of the class or academic oversight may open its gradesheet'
            );
        } catch (AuthorizationDenied $denial) {
            $this->attemptedOperation->deniedByActor($denial, $actor, 'academic.gradesheet.view', 'class', (string) $class->id);
        }
    }

    /**
     * Open assignments always view; ended assignments view while the
     * class period has not ended (D-F-058/D-F-066). Teachers without
     * any assignment on the class never view by identity.
     */
    private function mayView(Actor $actor, ClassModel $class): bool
    {
        $open = TeacherAssignment::query()
            ->where('class_id', $class->id)
            ->where('teacher_person_id', $actor->actorId)
            ->whereNull('effective_to')
            ->exists();
        if ($open) {
            return true;
        }

        $everAssigned = TeacherAssignment::query()
            ->where('class_id', $class->id)
            ->where('teacher_person_id', $actor->actorId)
            ->exists();
        if (! $everAssigned) {
            return false;
        }

        return ! $this->termEnded($class);
    }

    private function termEnded(ClassModel $class): bool
    {
        $endsOn = AcademicPeriod::query()->whereKey($class->period_id)->value('ends_on');
        if (! is_string($endsOn) || $endsOn === '') {
            return false;
        }

        return $endsOn < CarbonImmutable::today()->toDateString();
    }

    private function isOversight(Actor $actor): bool
    {
        foreach (self::OVERSIGHT_CAPABILITIES as $capability) {
            if ($this->access->decide($actor, $capability, null)->allowed) {
                return true;
            }
        }

        return false;
    }

    /**
     * @param  Collection<string, Collection<int, AssessmentResult>>  $resultsByAttempt
     * @param  Collection<string, ResultCorrection>  $openCorrections
     * @return array<string, mixed>
     */
    private function attemptRow(AssessmentAttempt $attempt, Collection $resultsByAttempt, Collection $openCorrections): array
    {
        /** @var Collection<int, AssessmentResult> $results */
        $results = $resultsByAttempt->get((string) $attempt->id, new Collection);

        // Live-result resolution mirrors TranscriptComposer exactly: the
        // latest non-corrected row, supersede-by-reference via corrects_id —
        // never by timestamp.
        $live = $results->filter(
            fn (AssessmentResult $result): bool => $result->lifecycle_state !== AssessmentResultLifecycle::STATE_CORRECTED
        )->last();

        $open = $live !== null ? $openCorrections->get((string) $live->id) : null;

        return [
            'attempt_id' => (string) $attempt->id,
            'kind' => $attempt->kind,
            'attempt_state' => $attempt->lifecycle_state,
            'evidence_ref' => $attempt->evidence_ref,
            'live' => $live !== null ? [
                'result_id' => (string) $live->id,
                'score' => (string) $live->score,
                'lifecycle_state' => $live->lifecycle_state,
                'official' => $live->lifecycle_state === AssessmentResultLifecycle::STATE_RELEASED,
                'scored_by' => $live->scored_by,
                'moderated_by' => $live->moderated_by,
                'approved_by' => $live->approved_by,
                'released_by' => $live->released_by,
            ] : null,
            'history' => $results->map(fn (AssessmentResult $result): array => [
                'result_id' => (string) $result->id,
                'score' => (string) $result->score,
                'lifecycle_state' => $result->lifecycle_state,
                'corrects_id' => $result->corrects_id !== null ? (string) $result->corrects_id : null,
                'correction_reason' => $result->correction_reason,
            ])->all(),
            'open_correction' => $open instanceof ResultCorrection ? [
                'correction_id' => (string) $open->id,
                'result_id' => (string) $open->result_id,
                'score' => (string) $open->score,
                'reason' => $open->reason,
                'proposed_by' => $open->proposed_by,
            ] : null,
        ];
    }
}
