<?php

declare(strict_types=1);

namespace App\Http\Controllers\Api;

use App\Http\Controllers\Controller;
use App\Modules\Academic\Commands\DecideGraduation;
use App\Modules\Academic\Commands\DecideProgression;
use App\Modules\Academic\Commands\IssueTranscript;
use App\Modules\Academic\Commands\MaintainAcademicStructure;
use App\Modules\Academic\Commands\MaintainClass;
use App\Modules\Academic\Commands\MaintainTeacherAssignment;
use App\Modules\Academic\Commands\MaintainEnrollment;
use App\Modules\Academic\Commands\ManageAcademicAppeal;
use App\Modules\Academic\Commands\ManageAssessmentResult;
use App\Modules\Academic\Commands\ManageClassWaitlist;
use App\Modules\Academic\Commands\MaintainRoom;
use App\Modules\Academic\Commands\MaintainSkill;
use App\Modules\Academic\Commands\ManageAcademicOffering;
use App\Modules\Academic\Commands\RecordAttendance;
use App\Modules\Academic\Domain\ClassLifecycle;
use App\Modules\Academic\Models\AcademicAppeal;
use App\Modules\Academic\Models\AcademicPeriod;
use App\Modules\Academic\Models\AcademicRoom;
use App\Modules\Academic\Models\AttendanceFact;
use App\Modules\Academic\Models\BranchAvailability;
use App\Modules\Academic\Models\ClassModel;
use App\Modules\Academic\Models\ClassSection;
use App\Modules\Academic\Models\ClassSession;
use App\Modules\Academic\Models\ClassWaitlistEntry;
use App\Modules\Academic\Models\AssessmentAttempt;
use App\Modules\Academic\Models\AssessmentResult;
use App\Modules\Academic\Models\Enrollment;
use App\Modules\Academic\Models\Offering;
use App\Modules\Academic\Models\ProgressionDecision;
use App\Modules\Academic\Models\Program;
use App\Modules\Academic\Models\ProgramVersion;
use App\Modules\Academic\Models\GraduationDecision;
use App\Modules\Academic\Models\LevelPrerequisite;
use App\Modules\Academic\Models\LevelProgressionRule;
use App\Modules\Academic\Models\ResultCorrection;
use App\Modules\Academic\Models\TeacherAssignment;
use App\Modules\Academic\Models\TeacherProfile;
use App\Modules\Academic\Models\Transcript;
use App\Modules\Academic\Placement\Models\PlacementProfile;
use App\Modules\Academic\Models\ProgramVersionLevel;
use App\Modules\Academic\Models\Skill;
use App\Modules\Identity\Models\Person;
use App\Modules\Organization\Models\Branch;
use App\Modules\Students\Models\Student;
use App\Support\Authorization\AccessDecision;
use Carbon\CarbonImmutable;
use Illuminate\Http\JsonResponse;
use Illuminate\Http\Request;

/**
 * Versioned JSON boundary for the Academic Classes workspace.
 *
 * This is a read projection, not a second authority: every mutation delegates
 * to the same Academic commands used by jobs and the compatibility console.
 * The payload deliberately exposes server-derived lifecycle, seat, waitlist,
 * provenance and capability state so React never invents academic truth.
 */
final class AcademicApiController extends Controller
{
    public function workspace(): JsonResponse
    {
        $structureAllowed = app(AccessDecision::class)->decide($this->actor(), 'academic.structure', null)->allowed;
        $branchScopes = [
            'structure' => $this->authorizedBranches('academic.structure'),
            'schedule' => $this->authorizedBranches('academic.schedule'),
            'attendance' => $this->authorizedBranches('academic.attendance'),
            'enroll' => $this->authorizedBranches('academic.enroll'),
            'enroll_approve' => $this->authorizedBranches('academic.enroll_approve'),
            'assess' => $this->authorizedBranches('academic.assess'),
            'moderate' => $this->authorizedBranches('academic.moderate'),
            'approve_result' => $this->authorizedBranches('academic.approve_result'),
            'release_result' => $this->authorizedBranches('academic.release'),
            'progression_propose' => $this->authorizedBranches('academic.progression_propose'),
            'progression_review' => $this->authorizedBranches('academic.progression_review'),
            'progression_approve' => $this->authorizedBranches('academic.progression_approve'),
            'completion' => $this->authorizedBranches('academic.completion'),
            'completion_approve' => $this->authorizedBranches('academic.completion_approve'),
            'certify' => $this->authorizedBranches('academic.certify'),
            'transcript_issue' => $this->authorizedBranches('academic.transcript_issue'),
            'appeal_manage' => $this->authorizedBranches('academic.appeal_manage'),
        ];
        $classReadBranches = array_values(array_unique(array_merge(
            $branchScopes['structure'],
            $branchScopes['schedule'],
            $branchScopes['attendance'],
            $branchScopes['enroll'],
            $branchScopes['enroll_approve'],
            $branchScopes['assess'],
            $branchScopes['moderate'],
            $branchScopes['approve_result'],
            $branchScopes['release_result'],
            $branchScopes['progression_propose'],
            $branchScopes['progression_review'],
            $branchScopes['progression_approve'],
        )));
        $visibleBranches = array_values(array_unique(array_merge($classReadBranches, $branchScopes['completion'], $branchScopes['completion_approve'], $branchScopes['certify'], $branchScopes['transcript_issue'], $branchScopes['appeal_manage'])));

        $branches = $visibleBranches === []
            ? []
            : Branch::query()->whereIn('id', $visibleBranches)->where('lifecycle_state', 'active')->orderBy('name')->get(['id', 'name'])->map(static fn (Branch $branch): array => [
                'id' => (string) $branch->id,
                'name' => (string) $branch->name,
                'organization_id' => $branch->structureScope()->organizationId !== '' ? $branch->structureScope()->organizationId : null,
                'campus_id' => $branch->structureScope()->campusId,
            ])->all();

        $classes = $classReadBranches === []
            ? collect()
            : ClassModel::query()
                ->with([
                    'offering:id,branch_id,program_version_level_id,academic_period_id,capacity,lifecycle_state',
                    'sections:id,class_id,name,capacity,lifecycle_state',
                    'teacherAssignments:id,class_id,teacher_person_id,teacher_profile_id,branch_id,campus_id,organization_id,effective_from,effective_to',
                    'teacherAssignments.teacherProfile:id,person_id',
                ])
                ->withCount([
                    'enrollments as requested_seats' => static fn ($query) => $query->where('lifecycle_state', 'requested'),
                    'enrollments as active_seats' => static fn ($query) => $query->where('lifecycle_state', 'active'),
                    'enrollments as frozen_seats' => static fn ($query) => $query->where('lifecycle_state', 'frozen'),
                    'enrollments as claimed_seats' => static fn ($query) => $query->whereIn('lifecycle_state', ['requested', 'active', 'frozen']),
                    'waitlistEntries as open_waitlist_entries' => static fn ($query) => $query->whereIn('lifecycle_state', ['waiting', 'offered']),
                ])
                ->whereIn('branch_id', $classReadBranches)
                ->orderByDesc('created_at')
                ->limit(300)
                ->get();

        $classRows = $classes->map(function (ClassModel $class) use ($branchScopes): array {
            $branchId = (string) $class->branch_id;
            $offering = $class->offering;

            return [
                'id' => (string) $class->id,
                'branch_id' => $branchId,
                'organization_id' => $this->organizationIdForBranch($branchId),
                'campus_id' => $this->campusIdForBranch($branchId),
                'program_version_id' => (string) $class->program_version_id,
                'program_version_level_id' => $class->program_version_level_id !== null ? (string) $class->program_version_level_id : null,
                'period_id' => (string) $class->period_id,
                'offering_id' => $class->offering_id !== null ? (string) $class->offering_id : null,
                'capacity' => (int) $class->capacity,
                'requested_seats' => (int) $class->requested_seats,
                'active_seats' => (int) $class->active_seats,
                'frozen_seats' => (int) $class->frozen_seats,
                'claimed_seats' => (int) $class->claimed_seats,
                'remaining_seats' => max(0, (int) $class->capacity - (int) $class->claimed_seats),
                'open_waitlist_entries' => (int) $class->open_waitlist_entries,
                'lifecycle_state' => (string) $class->lifecycle_state,
                'allowed_transitions' => array_values(array_filter(ClassLifecycle::states(), static fn (string $state): bool => ClassLifecycle::allowsTransition((string) $class->lifecycle_state, $state))),
                'offering' => $offering === null ? null : [
                    'id' => (string) $offering->id,
                    'capacity' => (int) $offering->capacity,
                    'lifecycle_state' => (string) $offering->lifecycle_state,
                ],
                'sections' => $class->sections->map(static fn (ClassSection $section): array => [
                    'id' => (string) $section->id,
                    'name' => (string) $section->name,
                    'capacity' => (int) $section->capacity,
                    'lifecycle_state' => (string) $section->lifecycle_state,
                ])->values()->all(),
                'teachers' => $class->teacherAssignments->map(static fn (TeacherAssignment $assignment): array => [
                    'id' => (string) $assignment->id,
                    'teacher_person_id' => (string) $assignment->teacher_person_id,
                    'teacher_profile_id' => $assignment->teacher_profile_id !== null ? (string) $assignment->teacher_profile_id : null,
                    'identity_consistent' => $assignment->teacherProfile !== null && (string) $assignment->teacher_person_id === (string) $assignment->teacherProfile->person_id,
                    'assignment_branch_id' => $assignment->branch_id !== null ? (string) $assignment->branch_id : null,
                    'assignment_campus_id' => $assignment->campus_id !== null ? (string) $assignment->campus_id : null,
                    'assignment_organization_id' => $assignment->organization_id !== null ? (string) $assignment->organization_id : null,
                    'lifecycle_state' => $assignment->lifecycle_state,
                    'effective_from' => (string) $assignment->effective_from,
                    'effective_to' => $assignment->effective_to !== null ? (string) $assignment->effective_to : null,
                    'current' => $assignment->teacherProfile !== null && (string) $assignment->teacher_person_id === (string) $assignment->teacherProfile->person_id && $assignment->effective_to === null && $assignment->lifecycle_state !== 'cancelled',
                ])->values()->all(),
                'capabilities' => [
                    'schedule' => in_array($branchId, $branchScopes['schedule'], true),
                    'attendance' => in_array($branchId, $branchScopes['attendance'], true),
                    'request_enrollment' => in_array($branchId, $branchScopes['enroll'], true),
                    'approve_enrollment' => in_array($branchId, $branchScopes['enroll_approve'], true),
                    'assess' => in_array($branchId, $branchScopes['assess'], true),
                    'moderate_assessment' => in_array($branchId, $branchScopes['moderate'], true),
                    'approve_assessment' => in_array($branchId, $branchScopes['approve_result'], true),
                    'release_assessment' => in_array($branchId, $branchScopes['release_result'], true),
                    'propose_progression' => in_array($branchId, $branchScopes['progression_propose'], true),
                    'review_progression' => in_array($branchId, $branchScopes['progression_review'], true),
                    'approve_progression' => in_array($branchId, $branchScopes['progression_approve'], true),
                ],
            ];
        })->values()->all();

        $classIds = $classes->pluck('id')->values()->all();
        $deliveryBranches = array_values(array_unique(array_merge($branchScopes['schedule'], $branchScopes['attendance'])));
        $enrollmentBranches = array_values(array_unique(array_merge($branchScopes['enroll'], $branchScopes['enroll_approve'])));
        $outcomeBranches = array_values(array_unique(array_merge(
            $branchScopes['assess'],
            $branchScopes['moderate'],
            $branchScopes['approve_result'],
            $branchScopes['release_result'],
            $branchScopes['progression_propose'],
            $branchScopes['progression_review'],
            $branchScopes['progression_approve'],
        )));
        $outcomeClassIds = $classes->filter(static fn (ClassModel $class): bool => in_array((string) $class->branch_id, $outcomeBranches, true))->pluck('id')->values()->all();
        $deliveryClassIds = $classes->filter(static fn (ClassModel $class): bool => in_array((string) $class->branch_id, $deliveryBranches, true))->pluck('id')->values()->all();
        $attendanceClassIds = $classes->filter(static fn (ClassModel $class): bool => in_array((string) $class->branch_id, $branchScopes['attendance'], true))->pluck('id')->values()->all();
        $enrollmentClassIds = $classes->filter(static fn (ClassModel $class): bool => in_array((string) $class->branch_id, $enrollmentBranches, true))->pluck('id')->values()->all();
        $sessions = $deliveryClassIds === []
            ? []
            : ClassSession::query()->with(['room:id,name,code', 'section:id,name'])->whereIn('class_id', $deliveryClassIds)->orderByDesc('scheduled_on')->orderBy('starts_at')->limit(500)->get()->map(static fn (ClassSession $session): array => [
                'id' => (string) $session->id,
                'class_id' => (string) $session->class_id,
                'scheduled_on' => (string) $session->scheduled_on,
                'starts_at' => (string) $session->starts_at,
                'ends_at' => (string) $session->ends_at,
                'skill_id' => $session->skill_id !== null ? (string) $session->skill_id : null,
                'room_id' => $session->room_id !== null ? (string) $session->room_id : null,
                'section_id' => $session->section_id !== null ? (string) $session->section_id : null,
                'room' => $session->room === null ? null : ['id' => (string) $session->room->id, 'name' => (string) $session->room->name, 'code' => (string) $session->room->code],
                'section' => $session->section === null ? null : ['id' => (string) $session->section->id, 'name' => (string) $session->section->name],
            ])->all();

        $enrollments = $enrollmentClassIds === []
            ? []
            : Enrollment::query()->whereIn('class_id', $enrollmentClassIds)->whereIn('lifecycle_state', ['requested', 'active', 'frozen'])->orderBy('class_id')->orderBy('created_at')->limit(1000)->get()->map(static fn (Enrollment $enrollment): array => [
                'id' => (string) $enrollment->id,
                'student_id' => (string) $enrollment->student_id,
                'class_id' => (string) $enrollment->class_id,
                'offering_id' => $enrollment->offering_id !== null ? (string) $enrollment->offering_id : null,
                'lifecycle_state' => (string) $enrollment->lifecycle_state,
                'state_reason' => $enrollment->state_reason !== null ? (string) $enrollment->state_reason : null,
            ])->all();

        $waitlist = $enrollmentClassIds === []
            ? []
            : ClassWaitlistEntry::query()->whereIn('class_id', $enrollmentClassIds)->whereIn('lifecycle_state', ['waiting', 'offered'])->orderBy('class_id')->orderBy('position')->limit(1000)->get()->map(static fn (ClassWaitlistEntry $entry): array => [
                'id' => (string) $entry->id,
                'class_id' => (string) $entry->class_id,
                'student_id' => (string) $entry->student_id,
                'offering_id' => $entry->offering_id !== null ? (string) $entry->offering_id : null,
                'position' => (int) $entry->position,
                'lifecycle_state' => (string) $entry->lifecycle_state,
            ])->all();

        $attendance = $attendanceClassIds === []
            ? []
            : AttendanceFact::query()->whereIn('session_id', ClassSession::query()->whereIn('class_id', $attendanceClassIds)->select('id'))->orderByDesc('created_at')->limit(1000)->get()->map(static fn (AttendanceFact $fact): array => [
                'id' => (string) $fact->id,
                'session_id' => (string) $fact->session_id,
                'enrollment_id' => (string) $fact->enrollment_id,
                'status' => (string) $fact->status,
                'corrects_id' => $fact->corrects_id !== null ? (string) $fact->corrects_id : null,
                'reason' => $fact->reason !== null ? (string) $fact->reason : null,
            ])->all();

        $attempts = $outcomeClassIds === []
            ? []
            : AssessmentAttempt::query()->whereIn('enrollment_id', Enrollment::query()->whereIn('class_id', $outcomeClassIds)->select('id'))->orderByDesc('created_at')->limit(1000)->get()->map(static fn (AssessmentAttempt $attempt): array => [
                'id' => (string) $attempt->id,
                'enrollment_id' => (string) $attempt->enrollment_id,
                'assessed_on' => $attempt->assessed_on !== null ? (string) $attempt->assessed_on : null,
                'kind' => (string) $attempt->kind,
                'evidence_ref' => (string) $attempt->evidence_ref,
                'lifecycle_state' => (string) $attempt->lifecycle_state,
            ])->all();
        $attemptIds = collect($attempts)->pluck('id')->all();
        $results = $attemptIds === []
            ? []
            : AssessmentResult::query()->whereIn('attempt_id', $attemptIds)->orderByDesc('created_at')->limit(1000)->get()->map(static fn (AssessmentResult $result): array => [
                'id' => (string) $result->id,
                'attempt_id' => (string) $result->attempt_id,
                'score' => (string) $result->score,
                'lifecycle_state' => (string) $result->lifecycle_state,
            ])->all();
        $progressions = $outcomeClassIds === []
            ? []
            : ProgressionDecision::query()->whereIn('class_id', $outcomeClassIds)->orderByDesc('created_at')->limit(1000)->get()->map(static fn (ProgressionDecision $decision): array => [
                'id' => (string) $decision->id,
                'class_id' => (string) $decision->class_id,
                'student_id' => (string) $decision->student_id,
                'outcome' => (string) $decision->outcome,
                'reason' => (string) $decision->reason,
                'lifecycle_state' => (string) $decision->lifecycle_state,
                'proposed_by' => $decision->proposed_by !== null ? (string) $decision->proposed_by : null,
                'reviewed_by' => $decision->reviewed_by !== null ? (string) $decision->reviewed_by : null,
                'approved_by' => $decision->approved_by !== null ? (string) $decision->approved_by : null,
                'appeal_reviewed_by' => $decision->appeal_reviewed_by !== null ? (string) $decision->appeal_reviewed_by : null,
                'superseded_by_id' => $decision->superseded_by_id !== null ? (string) $decision->superseded_by_id : null,
                'assessment_result_id' => $decision->assessment_result_id !== null ? (string) $decision->assessment_result_id : null,
            ])->all();

        $graduationBranches = array_values(array_unique(array_merge(
            $branchScopes['completion'],
            $branchScopes['completion_approve'],
            $branchScopes['certify'],
        )));
        $transcriptBranches = $branchScopes['transcript_issue'];
        $appealBranches = $branchScopes['appeal_manage'];
        $studentIdsForBranches = static function (array $branchIds): array {
            if ($branchIds === []) {
                return [];
            }

            return Student::query()->where(function ($query) use ($branchIds): void {
                $query->whereIn('current_home_branch_id', $branchIds)
                    ->orWhere(function ($fallback) use ($branchIds): void {
                        $fallback->whereNull('current_home_branch_id')->whereIn('originating_branch_id', $branchIds);
                    });
            })->pluck('id')->all();
        };
        $graduationStudentIds = $studentIdsForBranches($graduationBranches);
        $transcriptStudentIds = $studentIdsForBranches($transcriptBranches);
        $appealStudentIds = $studentIdsForBranches($appealBranches);
        $appealPlacementProfileIds = $appealBranches === []
            ? []
            : PlacementProfile::query()->where(function ($query) use ($appealBranches): void {
                $query->whereIn('current_home_branch_id', $appealBranches)
                    ->orWhere(function ($fallback) use ($appealBranches): void {
                        $fallback->whereNull('current_home_branch_id')->whereIn('originating_branch_id', $appealBranches);
                    });
            })->pluck('id')->all();
        $studentReadBranches = array_values(array_unique(array_merge($enrollmentBranches, $branchScopes['attendance'], $outcomeBranches, $graduationBranches, $transcriptBranches, $appealBranches)));
        $graduations = $graduationStudentIds === []
            ? []
            : GraduationDecision::query()->whereIn('student_id', $graduationStudentIds)->orderByDesc('created_at')->limit(500)->get()->map(static fn (GraduationDecision $decision): array => [
                'id' => (string) $decision->id,
                'student_id' => (string) $decision->student_id,
                'program_version_id' => (string) $decision->program_version_id,
                'outcome' => (string) $decision->outcome,
                'basis' => (string) $decision->basis,
                'lifecycle_state' => (string) $decision->lifecycle_state,
                'proposed_by' => $decision->proposed_by !== null ? (string) $decision->proposed_by : null,
                'reviewed_by' => $decision->reviewed_by !== null ? (string) $decision->reviewed_by : null,
                'approved_by' => $decision->approved_by !== null ? (string) $decision->approved_by : null,
            ])->all();
        $transcripts = $transcriptStudentIds === []
            ? []
            : Transcript::query()->whereIn('student_id', $transcriptStudentIds)->orderByDesc('issued_at')->limit(500)->get()->map(static fn (Transcript $transcript): array => [
                'id' => (string) $transcript->id,
                'student_id' => (string) $transcript->student_id,
                'program_version_id' => (string) $transcript->program_version_id,
                'content_hash' => (string) $transcript->content_hash,
                'document_id' => (string) $transcript->document_id,
                'issued_by' => (string) $transcript->issued_by,
                'issued_at' => $transcript->issued_at?->toIso8601String(),
            ])->all();
        $appeals = ($appealStudentIds === [] && $appealPlacementProfileIds === [])
            ? []
            : AcademicAppeal::query()->where(function ($query) use ($appealStudentIds, $appealPlacementProfileIds): void {
                if ($appealStudentIds !== []) {
                    $query->where(function ($studentSubject) use ($appealStudentIds): void {
                        $studentSubject->whereIn('subject_type', ['assessment_result', 'progression_decision'])
                            ->whereIn('student_id', $appealStudentIds);
                    });
                }
                if ($appealPlacementProfileIds !== []) {
                    $method = $appealStudentIds === [] ? 'where' : 'orWhere';
                    $query->{$method}(function ($placement) use ($appealPlacementProfileIds): void {
                        $placement->where('subject_type', 'placement_profile')->whereIn('subject_id', $appealPlacementProfileIds);
                    });
                }
            })->orderByDesc('created_at')->limit(500)->get()->map(static fn (AcademicAppeal $appeal): array => [
                'id' => (string) $appeal->id,
                'student_id' => $appeal->student_id !== null ? (string) $appeal->student_id : null,
                'subject_type' => (string) $appeal->subject_type,
                'subject_id' => (string) $appeal->subject_id,
                'reason' => (string) $appeal->reason,
                'lifecycle_state' => (string) $appeal->lifecycle_state,
                'assigned_reviewer_id' => $appeal->assigned_reviewer_id !== null ? (string) $appeal->assigned_reviewer_id : null,
                'outcome' => $appeal->outcome !== null ? (string) $appeal->outcome : null,
                'outcome_evidence' => $appeal->outcome_evidence !== null ? (string) $appeal->outcome_evidence : null,
            ])->all();

        $offerings = $structureAllowed && $branchScopes['structure'] !== []
            ? Offering::query()->whereIn('branch_id', $branchScopes['structure'])->withCount([
                'classes',
                'waitlistEntries as open_waitlist_entries' => static fn ($query) => $query->whereIn('lifecycle_state', ['waiting', 'offered']),
            ])->orderBy('academic_period_id')->orderBy('branch_id')->get()->map(function (Offering $offering): array {
                $counts = Enrollment::query()->where('offering_id', $offering->id)->whereIn('lifecycle_state', ['requested', 'active', 'frozen'])->selectRaw("count(*) filter (where lifecycle_state = 'requested') as requested_seats, count(*) filter (where lifecycle_state = 'active') as active_seats, count(*) filter (where lifecycle_state = 'frozen') as frozen_seats, count(*) as claimed_seats")->first();

                return [
                    'id' => (string) $offering->id,
                    'branch_id' => (string) $offering->branch_id,
                    'program_version_level_id' => (string) $offering->program_version_level_id,
                    'academic_period_id' => (string) $offering->academic_period_id,
                    'capacity' => (int) $offering->capacity,
                    'requested_seats' => (int) ($counts->requested_seats ?? 0),
                    'active_seats' => (int) ($counts->active_seats ?? 0),
                    'frozen_seats' => (int) ($counts->frozen_seats ?? 0),
                    'claimed_seats' => (int) ($counts->claimed_seats ?? 0),
                    'remaining_seats' => max(0, (int) $offering->capacity - (int) ($counts->claimed_seats ?? 0)),
                    'open_waitlist_entries' => (int) $offering->open_waitlist_entries,
                    'lifecycle_state' => (string) $offering->lifecycle_state,
                    'classes_count' => (int) $offering->classes_count,
                ];
            })->all()
            : [];

        $students = $studentReadBranches === []
            ? []
            : Student::query()->where(function ($query) use ($studentReadBranches): void {
                $query->whereIn('current_home_branch_id', $studentReadBranches)
                    ->orWhere(function ($fallback) use ($studentReadBranches): void {
                        $fallback->whereNull('current_home_branch_id')->whereIn('originating_branch_id', $studentReadBranches);
                    });
            })->with('person:id,legal_name')->orderBy('student_code')->limit(500)->get()->map(static fn (Student $student): array => [
                'id' => (string) $student->id,
                'student_code' => (string) $student->student_code,
                'name' => $student->person === null ? (string) $student->student_code : (string) $student->person->legal_name,
                'branch_id' => $student->current_home_branch_id !== null ? (string) $student->current_home_branch_id : (string) $student->originating_branch_id,
            ])->all();

        $teachers = $branchScopes['schedule'] === []
            ? []
            : TeacherProfile::query()
                ->where('lifecycle_state', TeacherProfile::STATE_ACTIVE)
                ->whereHas('person', static fn ($query) => $query->where('verification_state', Person::VERIFICATION_VERIFIED))
                ->whereHas('employment', static fn ($query) => $query->where('lifecycle_state', 'active'))
                ->whereHas('branchAuthorizations', function ($query) use ($branchScopes): void {
                    $query->whereIn('branch_id', $branchScopes['schedule'])->where('lifecycle_state', 'active')->where('effective_from', '<=', now()->toDateString())->where(function ($valid): void {
                        $valid->whereNull('effective_to')->orWhere('effective_to', '>', now()->toDateString());
                    });
                })
                ->with(['person:id,legal_name', 'branchAuthorizations'])
                ->orderBy('id')->limit(500)->get()->flatMap(function (TeacherProfile $profile) use ($branchScopes): array {
                    /** @var \App\Modules\Identity\Models\Person|null $profilePerson */
                    $profilePerson = $profile->person;
                    return $profile->branchAuthorizations->filter(static fn ($authorization): bool => $authorization->lifecycle_state === 'active' && in_array((string) $authorization->branch_id, $branchScopes['schedule'], true) && (string) $authorization->effective_from <= now()->toDateString() && ($authorization->effective_to === null || (string) $authorization->effective_to > now()->toDateString()))->map(static fn ($authorization): array => [
                        'id' => (string) $profile->person_id,
                        'teacher_profile_id' => (string) $profile->id,
                        'name' => $profilePerson !== null ? (string) $profilePerson->legal_name : (string) $profile->person_id,
                        'branch_id' => (string) $authorization->branch_id,
                    ])->all();
                })->values()->all();

        $rooms = $branchScopes['schedule'] === []
            ? []
            : AcademicRoom::query()->whereIn('branch_id', $branchScopes['schedule'])->where('lifecycle_state', 'available')->orderBy('branch_id')->orderBy('code')->get(['id', 'branch_id', 'name', 'code', 'capacity'])->map(static fn (AcademicRoom $room): array => [
                'id' => (string) $room->id,
                'branch_id' => (string) $room->branch_id,
                'name' => (string) $room->name,
                'code' => (string) $room->code,
                'capacity' => (int) $room->capacity,
            ])->all();

        $periods = $structureAllowed ? AcademicPeriod::query()->orderBy('starts_on')->limit(200)->get(['id', 'name', 'starts_on', 'ends_on', 'lifecycle_state'])->map(static fn (AcademicPeriod $period): array => [
            'id' => (string) $period->id,
            'name' => (string) $period->name,
            'starts_on' => (string) $period->starts_on,
            'ends_on' => (string) $period->ends_on,
            'lifecycle_state' => (string) $period->lifecycle_state,
        ])->all() : [];

        $levels = $structureAllowed ? ProgramVersionLevel::query()->where('lifecycle_state', 'active')->orderBy('program_version_id')->orderBy('ordinal')->limit(500)->get(['id', 'program_version_id', 'level_key', 'ordinal', 'title', 'cefr_ref', 'lifecycle_state'])->map(static fn (ProgramVersionLevel $level): array => [
            'id' => (string) $level->id,
            'program_version_id' => (string) $level->program_version_id,
            'level_key' => (string) $level->level_key,
            'ordinal' => (int) $level->ordinal,
            'title' => (string) $level->title,
            'cefr_ref' => $level->cefr_ref !== null ? (string) $level->cefr_ref : null,
            'lifecycle_state' => (string) $level->lifecycle_state,
        ])->all() : [];

        $programVersions = $structureAllowed ? ProgramVersion::query()->with('program:id,name')->orderBy('program_id')->orderBy('version_no')->limit(300)->get(['id', 'program_id', 'version_no', 'summary'])->map(static fn (ProgramVersion $version): array => [
            'id' => (string) $version->id,
            'program_id' => (string) $version->program_id,
            'program_name' => $version->program === null ? 'Program' : (string) $version->program->name,
            'version_no' => (int) $version->version_no,
            'summary' => (string) $version->summary,
        ])->all() : [];

        $availabilities = $structureAllowed && $branchScopes['structure'] !== []
            ? BranchAvailability::query()->whereIn('branch_id', $branchScopes['structure'])->orderBy('academic_period_id')->get(['id', 'branch_id', 'program_version_level_id', 'academic_period_id', 'lifecycle_state'])->map(static fn (BranchAvailability $availability): array => [
                'id' => (string) $availability->id,
                'branch_id' => (string) $availability->branch_id,
                'program_version_level_id' => (string) $availability->program_version_level_id,
                'academic_period_id' => (string) $availability->academic_period_id,
                'lifecycle_state' => (string) $availability->lifecycle_state,
            ])->all()
            : [];

        return response()->json([
            'generated_at' => now()->toIso8601String(),
            'scope' => ['branches' => $branches, 'branch_ids' => $visibleBranches],
            'capabilities' => [
                'structure' => $structureAllowed,
                'branch_ids' => $branchScopes,
                'actions' => [
                    'define_program' => $structureAllowed,
                    'publish_program_version' => $structureAllowed,
                    'define_level' => $structureAllowed,
                    'define_period' => $structureAllowed,
                    'transition_period' => $structureAllowed,
                    'define_prerequisite' => $structureAllowed,
                    'retire_prerequisite' => $structureAllowed,
                    'define_progression_rule' => $structureAllowed,
                    'retire_progression_rule' => $structureAllowed,
                    'register_skill' => app(AccessDecision::class)->decide($this->actor(), 'academic.skill', null)->allowed,
                    'retire_skill' => app(AccessDecision::class)->decide($this->actor(), 'academic.skill', null)->allowed,
                    'declare_availability' => $branchScopes['structure'] !== [],
                    'manage_offering' => $branchScopes['structure'] !== [],
                    'manage_room' => $branchScopes['structure'] !== [],
                    'define_class' => $branchScopes['schedule'] !== [],
                    'schedule_session' => $branchScopes['schedule'] !== [],
                    'record_attendance' => $branchScopes['attendance'] !== [],
                    'request_enrollment' => $branchScopes['enroll'] !== [],
                    'approve_enrollment' => $branchScopes['enroll_approve'] !== [],
                    'manage_waitlist' => $branchScopes['enroll_approve'] !== [],
                    'submit_assessment' => $branchScopes['assess'] !== [],
                    'score_assessment' => $branchScopes['assess'] !== [],
                    'moderate_assessment' => $branchScopes['moderate'] !== [],
                    'approve_assessment' => $branchScopes['approve_result'] !== [],
                    'release_assessment' => $branchScopes['release_result'] !== [],
                    'propose_progression' => $branchScopes['progression_propose'] !== [],
                    'review_progression' => $branchScopes['progression_review'] !== [],
                    'approve_progression' => $branchScopes['progression_approve'] !== [],
                    'supersede_progression' => $branchScopes['progression_approve'] !== [],
                    'propose_graduation' => $branchScopes['completion'] !== [],
                    'review_graduation' => $branchScopes['completion'] !== [],
                    'approve_graduation' => $branchScopes['completion_approve'] !== [],
                    'issue_certificate' => $branchScopes['certify'] !== [],
                    'issue_transcript' => $branchScopes['transcript_issue'] !== [],
                    'manage_appeal' => $branchScopes['appeal_manage'] !== [],
                ],
            ],
            'classes' => $classRows,
            'offerings' => $offerings,
            'availabilities' => $availabilities,
            'sessions' => $sessions,
            'enrollments' => $enrollments,
            'waitlist' => $waitlist,
            'attendance' => $attendance,
            'attempts' => $attempts,
            'results' => $results,
            'progressions' => $progressions,
            'graduations' => $graduations,
            'transcripts' => $transcripts,
            'appeals' => $appeals,
            'students' => $students,
            'teachers' => $teachers,
            'rooms' => $rooms,
            'periods' => $periods,
            'program_versions' => $programVersions,
            'levels' => $levels,
            'skills' => $structureAllowed ? Skill::query()->where('lifecycle_state', 'active')->orderBy('key')->get(['id', 'key', 'name'])->map(static fn (Skill $skill): array => ['id' => (string) $skill->id, 'key' => (string) $skill->key, 'name' => (string) $skill->name])->all() : [],
        ]);
    }

    public function sessions(): JsonResponse
    {
        $visible = $this->authorizedBranches('academic.attendance');
        $sessions = $visible === [] ? [] : ClassSession::query()->with(['class', 'room', 'section'])->whereHas('class', fn ($query) => $query->whereIn('branch_id', $visible))->orderByDesc('class_sessions.scheduled_on')->limit(500)->get();

        return response()->json(['sessions' => $sessions]);
    }

    public function schedule(Request $request): JsonResponse
    {
        $input = $request->validate([
            'class_id' => ['required', 'string'],
            'scheduled_on' => ['required', 'date'],
            'starts_at' => ['required', 'string', 'regex:/^\d{2}:\d{2}$/'],
            'ends_at' => ['required', 'string', 'regex:/^\d{2}:\d{2}$/'],
            'skill_id' => ['nullable', 'string'],
            'room_id' => ['nullable', 'string'],
            'section_id' => ['nullable', 'string'],
        ]);

        $result = app(MaintainClass::class)->scheduleSession(
            $this->actor(),
            ClassModel::query()->findOrFail((string) $input['class_id']),
            CarbonImmutable::parse($input['scheduled_on']),
            $input['starts_at'],
            $input['ends_at'],
            $this->idempotencyKey('academic.schedule'),
            $this->optional($input['skill_id'] ?? null),
            $this->optional($input['room_id'] ?? null),
            $this->optional($input['section_id'] ?? null),
        );

        return response()->json(['status' => 'scheduled', ...$result], 201);
    }

    public function defineClass(Request $request): JsonResponse
    {
        $input = $request->validate([
            'program_version_id' => ['required', 'string'],
            'period_id' => ['required', 'string'],
            'capacity' => ['required', 'integer', 'min:1', 'max:10000'],
            'program_version_level_id' => ['required', 'string'],
            'branch_id' => ['required', 'string'],
            'offering_id' => ['required', 'string'],
        ]);

        $result = app(MaintainClass::class)->defineClass(
            $this->actor(), $input['program_version_id'], $input['period_id'], (int) $input['capacity'],
            $this->idempotencyKey('academic.class.define'), $input['program_version_level_id'], $input['branch_id'], $input['offering_id'],
        );

        return response()->json(['status' => 'defined', ...$result], 201);
    }

    public function transitionClass(Request $request, string $classId): JsonResponse
    {
        $input = $request->validate(['to_state' => ['required', 'in:published,active,completed,cancelled,archived']]);
        $result = app(MaintainClass::class)->transition($this->actor(), ClassModel::query()->findOrFail($classId), $input['to_state'], $this->idempotencyKey('academic.class.transition'));

        return response()->json(['status' => 'transitioned', ...$result]);
    }

    public function defineSection(Request $request): JsonResponse
    {
        $input = $request->validate(['class_id' => ['required', 'string'], 'name' => ['required', 'string', 'max:255'], 'capacity' => ['required', 'integer', 'min:1', 'max:10000']]);
        $result = app(MaintainClass::class)->defineSection($this->actor(), ClassModel::query()->findOrFail((string) $input['class_id']), $input['name'], (int) $input['capacity'], $this->idempotencyKey('academic.section.define'));

        return response()->json(['status' => 'defined', ...$result], 201);
    }

    public function transitionSection(Request $request, string $sectionId): JsonResponse
    {
        $input = $request->validate(['to_state' => ['required', 'in:open,closed,cancelled,archived']]);
        $result = app(MaintainClass::class)->transitionSection($this->actor(), ClassSection::query()->findOrFail((string) $sectionId), $input['to_state'], $this->idempotencyKey('academic.section.transition'));

        return response()->json(['status' => 'transitioned', ...$result]);
    }

    public function assignTeacher(Request $request): JsonResponse
    {
        $input = $request->validate(['class_id' => ['required', 'string'], 'teacher_person_id' => ['required', 'string'], 'effective_from' => ['required', 'date'], 'effective_to' => ['nullable', 'date', 'after:effective_from']]);
        $result = app(MaintainTeacherAssignment::class)->assignTeacher($this->actor(), ClassModel::query()->findOrFail((string) $input['class_id']), $input['teacher_person_id'], CarbonImmutable::parse($input['effective_from']), isset($input['effective_to']) && $input['effective_to'] !== '' ? CarbonImmutable::parse($input['effective_to']) : null, $this->idempotencyKey('academic.teacher.assign'));

        return response()->json(['status' => 'assigned', ...$result], 201);
    }

    public function attendance(Request $request, string $sessionId): JsonResponse
    {
        $input = $request->validate(['enrollment_id' => ['required', 'string'], 'status' => ['required', 'in:present,late,absent,excused']]);
        $result = app(RecordAttendance::class)->record($this->actor(), ClassSession::query()->findOrFail((string) $sessionId), Enrollment::query()->findOrFail((string) $input['enrollment_id']), $input['status'], $this->idempotencyKey('academic.attendance'));

        return response()->json(['status' => 'recorded', ...$result], 201);
    }

    public function requestEnrollment(Request $request): JsonResponse
    {
        $input = $request->validate(['student_id' => ['required', 'string'], 'class_id' => ['required', 'string'], 'offering_id' => ['nullable', 'string']]);
        $result = app(MaintainEnrollment::class)->request($this->actor(), $input['student_id'], $input['class_id'], $this->idempotencyKey('academic.enrollment.request'), $this->optional($input['offering_id'] ?? null));

        return response()->json(['status' => 'requested', ...$result], 201);
    }

    public function activateEnrollment(Request $request, string $enrollmentId): JsonResponse
    {
        $result = app(MaintainEnrollment::class)->activate($this->actor(), Enrollment::query()->findOrFail($enrollmentId), $this->idempotencyKey('academic.enrollment.activate'));

        return response()->json(['status' => 'activated', ...$result]);
    }

    public function waitlist(Request $request): JsonResponse
    {
        $input = $request->validate(['student_id' => ['required', 'string'], 'class_id' => ['required', 'string'], 'offering_id' => ['nullable', 'string']]);
        $result = app(ManageClassWaitlist::class)->join($this->actor(), $input['student_id'], $input['class_id'], $this->optional($input['offering_id'] ?? null), $this->idempotencyKey('academic.waitlist.join'));

        return response()->json(['status' => 'waiting', ...$result], 201);
    }

    public function offerWaitlist(Request $request, string $entryId): JsonResponse
    {
        $result = app(ManageClassWaitlist::class)->offer($this->actor(), ClassWaitlistEntry::query()->findOrFail($entryId), $this->idempotencyKey('academic.waitlist.offer'));

        return response()->json(['status' => 'offered', ...$result]);
    }

    public function promoteWaitlist(Request $request, string $entryId): JsonResponse
    {
        $result = app(ManageClassWaitlist::class)->promote($this->actor(), ClassWaitlistEntry::query()->findOrFail($entryId), $this->idempotencyKey('academic.waitlist.promote'));

        return response()->json(['status' => 'enrolled', ...$result]);
    }

    public function withdrawWaitlist(Request $request, string $entryId): JsonResponse
    {
        $result = app(ManageClassWaitlist::class)->withdraw($this->actor(), ClassWaitlistEntry::query()->findOrFail($entryId), $this->idempotencyKey('academic.waitlist.withdraw'));

        return response()->json(['status' => 'withdrawn', ...$result]);
    }

    public function transitionOffering(Request $request, string $offeringId, string $action): JsonResponse
    {
        $offering = Offering::query()->findOrFail($offeringId);
        $key = $this->idempotencyKey('academic.offering.'.$action);
        $command = app(ManageAcademicOffering::class);
        $result = match ($action) {
            'close' => $command->closeOffering($this->actor(), $offering, $key),
            'reopen' => $command->reopenOffering($this->actor(), $offering, $key),
            'cancel' => $command->cancelOffering($this->actor(), $offering, $key),
            'complete' => $command->completeOffering($this->actor(), $offering, $key),
            default => abort(422, 'Unsupported offering action.'),
        };

        return response()->json(['status' => 'transitioned', ...$result]);
    }

    public function correctAttendance(Request $request, string $factId): JsonResponse
    {
        $input = $request->validate([
            'status' => ['required', 'in:present,late,absent,excused'],
            'reason' => ['required', 'string', 'max:1000'],
        ]);
        $result = app(RecordAttendance::class)->correct(
            $this->actor(),
            AttendanceFact::query()->findOrFail($factId),
            $input['status'],
            $input['reason'],
            $this->idempotencyKey('academic.attendance.correct'),
        );

        return response()->json(['status' => 'corrected', ...$result], 201);
    }

    public function submitAttempt(Request $request): JsonResponse
    {
        $input = $request->validate([
            'enrollment_id' => ['required', 'string'],
            'kind' => ['required', 'in:placement,assessment'],
            'evidence_ref' => ['required', 'string', 'max:500'],
        ]);
        $result = app(ManageAssessmentResult::class)->submitAttempt(
            $this->actor(),
            Enrollment::query()->findOrFail((string) $input['enrollment_id']),
            $input['kind'],
            $input['evidence_ref'],
            $this->idempotencyKey('academic.attempt.submit'),
        );

        return response()->json(['status' => 'submitted', ...$result], 201);
    }

    public function scoreAttempt(Request $request, string $attemptId): JsonResponse
    {
        $input = $request->validate(['score' => ['required', 'numeric', 'min:0']]);
        $result = app(ManageAssessmentResult::class)->score(
            $this->actor(),
            AssessmentAttempt::query()->findOrFail($attemptId),
            (string) $input['score'],
            $this->idempotencyKey('academic.result.score'),
        );

        return response()->json(['status' => 'scored', ...$result], 201);
    }

    public function transitionAssessment(Request $request, string $resultId, string $action): JsonResponse
    {
        $result = AssessmentResult::query()->findOrFail($resultId);
        $command = app(ManageAssessmentResult::class);
        $key = $this->idempotencyKey('academic.result.'.$action);
        $transition = match ($action) {
            'moderate' => $command->moderate($this->actor(), $result, $key),
            'approve' => $command->approve($this->actor(), $result, $key),
            'release' => $command->release($this->actor(), $result, $key),
            'mark-appealed' => $command->markAppealed($this->actor(), $result, $key),
            default => abort(422, 'Unsupported assessment action.'),
        };

        return response()->json(['status' => 'transitioned', ...$transition]);
    }

    public function proposeAssessmentCorrection(Request $request, string $resultId): JsonResponse
    {
        $input = $request->validate([
            'score' => ['required', 'numeric', 'min:0'],
            'reason' => ['required', 'string', 'max:1000'],
        ]);
        $result = app(ManageAssessmentResult::class)->proposeCorrection(
            $this->actor(),
            AssessmentResult::query()->findOrFail($resultId),
            (string) $input['score'],
            $input['reason'],
            $this->idempotencyKey('academic.result.correction.propose'),
        );

        return response()->json(['status' => 'proposed', ...$result], 201);
    }

    public function approveAssessmentCorrection(Request $request, string $correctionId): JsonResponse
    {
        $result = app(ManageAssessmentResult::class)->approveCorrection(
            $this->actor(),
            ResultCorrection::query()->findOrFail($correctionId),
            $this->idempotencyKey('academic.result.correction.approve'),
        );

        return response()->json(['status' => 'approved', ...$result]);
    }

    public function proposeProgression(Request $request): JsonResponse
    {
        $input = $request->validate([
            'student_id' => ['required', 'string'],
            'class_id' => ['required', 'string'],
            'outcome' => ['required', 'in:advance,repeat'],
            'reason' => ['required', 'string', 'max:1000'],
            'assessment_result_id' => ['nullable', 'string'],
            'basis' => ['nullable', 'string', 'max:1000'],
            'repeat_count' => ['nullable', 'integer', 'min:1'],
        ]);
        $result = app(DecideProgression::class)->propose(
            $this->actor(),
            $input['student_id'],
            $input['class_id'],
            $input['outcome'],
            $input['reason'],
            $this->idempotencyKey('academic.progression.propose'),
            $this->optional($input['assessment_result_id'] ?? null),
            $this->optional($input['basis'] ?? null),
            isset($input['repeat_count']) ? (int) $input['repeat_count'] : null,
        );

        return response()->json(['status' => 'proposed', ...$result], 201);
    }

    public function transitionProgression(Request $request, string $decisionId, string $action): JsonResponse
    {
        $decision = ProgressionDecision::query()->findOrFail($decisionId);
        $command = app(DecideProgression::class);
        $key = $this->idempotencyKey('academic.progression.'.$action);
        $transition = match ($action) {
            'review' => $command->review($this->actor(), $decision, $key),
            'approve' => $command->approve($this->actor(), $decision, $key),
            'reject' => $command->reject($this->actor(), $decision, $key),
            'mark-appealed' => $command->markAppealed($this->actor(), $decision, $key),
            'supersede' => $this->supersedeProgression($request, $command, $decision, $key),
            default => abort(422, 'Unsupported progression action.'),
        };

        return response()->json(['status' => 'transitioned', ...$transition]);
    }

    public function defineProgram(Request $request): JsonResponse
    {
        $input = $request->validate(['name' => ['required', 'string', 'max:160']]);
        $result = app(MaintainAcademicStructure::class)->defineProgram($this->actor(), $input['name'], $this->idempotencyKey('academic.program.define'));

        return response()->json(['status' => 'defined', ...$result], 201);
    }

    public function publishProgramVersion(Request $request, string $programId): JsonResponse
    {
        $input = $request->validate(['summary' => ['required', 'string', 'max:1000']]);
        $result = app(MaintainAcademicStructure::class)->publishVersion($this->actor(), Program::query()->findOrFail($programId), $input['summary'], $this->idempotencyKey('academic.version.publish'));

        return response()->json(['status' => 'published', ...$result], 201);
    }

    public function defineLevel(Request $request): JsonResponse
    {
        $input = $request->validate([
            'program_version_id' => ['required', 'string'], 'level_key' => ['required', 'string', 'max:120'],
            'ordinal' => ['required', 'integer', 'min:1', 'max:1000'], 'title' => ['required', 'string', 'max:200'],
            'cefr_ref' => ['nullable', 'string', 'max:20'],
        ]);
        $result = app(MaintainAcademicStructure::class)->defineLevel(
            $this->actor(), $input['program_version_id'], $input['level_key'], (int) $input['ordinal'], $input['title'],
            $this->optional($input['cefr_ref'] ?? null), $this->idempotencyKey('academic.level.define'),
        );

        return response()->json(['status' => 'defined', ...$result], 201);
    }

    public function definePeriod(Request $request): JsonResponse
    {
        $input = $request->validate([
            'name' => ['required', 'string', 'max:160'], 'starts_on' => ['required', 'date'],
            'ends_on' => ['required', 'date', 'after_or_equal:starts_on'],
        ]);
        $result = app(MaintainAcademicStructure::class)->definePeriod(
            $this->actor(), $input['name'], CarbonImmutable::parse($input['starts_on']), CarbonImmutable::parse($input['ends_on']),
            $this->idempotencyKey('academic.period.define'),
        );

        return response()->json(['status' => 'defined', ...$result], 201);
    }

    public function transitionPeriod(Request $request, string $periodId): JsonResponse
    {
        $input = $request->validate(['to_state' => ['required', 'in:published,closed']]);
        $result = app(MaintainAcademicStructure::class)->transitionPeriod($this->actor(), AcademicPeriod::query()->findOrFail($periodId), $input['to_state'], $this->idempotencyKey('academic.period.transition'));

        return response()->json(['status' => 'transitioned', ...$result]);
    }

    public function definePrerequisite(Request $request): JsonResponse
    {
        $input = $request->validate(['target_level_id' => ['required', 'string'], 'required_level_id' => ['required', 'string']]);
        $result = app(MaintainAcademicStructure::class)->definePrerequisite($this->actor(), $input['target_level_id'], $input['required_level_id'], $this->idempotencyKey('academic.prerequisite.define'));

        return response()->json(['status' => 'defined', ...$result], 201);
    }

    public function retirePrerequisite(Request $request, string $prerequisiteId): JsonResponse
    {
        $result = app(MaintainAcademicStructure::class)->retirePrerequisite($this->actor(), LevelPrerequisite::query()->findOrFail($prerequisiteId), $this->idempotencyKey('academic.prerequisite.retire'));

        return response()->json(['status' => 'retired', ...$result]);
    }

    /** @return array{decision_id: string, superseded_id: string, correlation_id: string} */
    private function supersedeProgression(Request $request, DecideProgression $command, ProgressionDecision $decision, string $key): array
    {
        $input = $request->validate([
            'outcome' => ['required', 'in:advance,repeat'],
            'reason' => ['required', 'string', 'max:1000'],
            'assessment_result_id' => ['nullable', 'string'],
            'basis' => ['nullable', 'string', 'max:1000'],
            'repeat_count' => ['nullable', 'integer', 'min:1'],
        ]);
        return $command->supersedeByApprover(
            $this->actor(), $decision, $input['outcome'], $input['reason'], $key,
            $this->optional($input['assessment_result_id'] ?? null), $this->optional($input['basis'] ?? null),
            isset($input['repeat_count']) ? (int) $input['repeat_count'] : null,
        );
    }

    public function defineProgressionRule(Request $request): JsonResponse
    {
        $input = $request->validate([
            'program_version_level_id' => ['required', 'string'], 'minimum_passing_score' => ['nullable', 'numeric', 'min:0', 'max:100'],
            'max_repeats' => ['nullable', 'integer', 'min:1', 'max:100'],
        ]);
        $result = app(MaintainAcademicStructure::class)->defineProgressionRule(
            $this->actor(), $input['program_version_level_id'], $this->optional(isset($input['minimum_passing_score']) ? (string) $input['minimum_passing_score'] : null),
            isset($input['max_repeats']) ? (int) $input['max_repeats'] : null, $this->idempotencyKey('academic.progression_rule.define'),
        );

        return response()->json(['status' => 'defined', ...$result], 201);
    }

    public function retireProgressionRule(Request $request, string $ruleId): JsonResponse
    {
        $result = app(MaintainAcademicStructure::class)->retireProgressionRule($this->actor(), LevelProgressionRule::query()->findOrFail($ruleId), $this->idempotencyKey('academic.progression_rule.retire'));

        return response()->json(['status' => 'retired', ...$result]);
    }

    public function registerSkill(Request $request): JsonResponse
    {
        $input = $request->validate(['key' => ['required', 'string', 'max:60'], 'name' => ['required', 'string', 'max:160']]);
        $result = app(MaintainSkill::class)->register($this->actor(), $input['key'], $input['name'], $this->idempotencyKey('academic.skill.register'));

        return response()->json(['status' => 'registered', ...$result], 201);
    }

    public function retireSkill(Request $request, string $skillId): JsonResponse
    {
        $result = app(MaintainSkill::class)->retire($this->actor(), Skill::query()->findOrFail($skillId), $this->idempotencyKey('academic.skill.retire'));

        return response()->json(['status' => 'retired', ...$result]);
    }

    public function declareAvailability(Request $request): JsonResponse
    {
        $input = $request->validate(['branch_id' => ['required', 'string'], 'program_version_level_id' => ['required', 'string'], 'academic_period_id' => ['required', 'string']]);
        $result = app(MaintainAcademicStructure::class)->declareBranchAvailability($this->actor(), $input['branch_id'], $input['program_version_level_id'], $input['academic_period_id'], $this->idempotencyKey('academic.availability.declare'));

        return response()->json(['status' => 'declared', ...$result], 201);
    }

    public function transitionAvailability(Request $request, string $availabilityId, string $action): JsonResponse
    {
        $availability = BranchAvailability::query()->findOrFail($availabilityId);
        $command = app(ManageAcademicOffering::class);
        $key = $this->idempotencyKey('academic.availability.'.$action);
        $result = match ($action) {
            'close' => $command->closeAvailability($this->actor(), $availability, $key),
            'reopen' => $command->reopenAvailability($this->actor(), $availability, $key),
            default => abort(422, 'Unsupported availability action.'),
        };

        return response()->json(['status' => 'transitioned', ...$result]);
    }

    public function openOffering(Request $request): JsonResponse
    {
        $input = $request->validate([
            'branch_id' => ['required', 'string'], 'program_version_level_id' => ['required', 'string'], 'academic_period_id' => ['required', 'string'],
            'capacity' => ['required', 'integer', 'min:1', 'max:10000'],
        ]);
        $result = app(MaintainAcademicStructure::class)->openOffering($this->actor(), $input['branch_id'], $input['program_version_level_id'], $input['academic_period_id'], (int) $input['capacity'], $this->idempotencyKey('academic.offering.open'));

        return response()->json(['status' => 'open', ...$result], 201);
    }

    public function resizeOffering(Request $request, string $offeringId): JsonResponse
    {
        $input = $request->validate(['capacity' => ['required', 'integer', 'min:1', 'max:10000']]);
        $result = app(ManageAcademicOffering::class)->resizeCapacity($this->actor(), Offering::query()->findOrFail($offeringId), (int) $input['capacity'], $this->idempotencyKey('academic.offering.resize'));

        return response()->json(['status' => 'resized', ...$result]);
    }

    public function defineRoom(Request $request): JsonResponse
    {
        $input = $request->validate([
            'branch_id' => ['required', 'string'], 'name' => ['required', 'string', 'max:255'], 'code' => ['required', 'string', 'max:255'],
            'capacity' => ['required', 'integer', 'min:1', 'max:10000'], 'room_type' => ['required', 'in:classroom,lab,computer,hall,other'],
        ]);
        $result = app(MaintainRoom::class)->defineRoom($this->actor(), $input['branch_id'], $input['name'], $input['code'], (int) $input['capacity'], $input['room_type'], $this->idempotencyKey('academic.room.define'));

        return response()->json(['status' => 'defined', ...$result], 201);
    }

    public function transitionRoom(Request $request, string $roomId): JsonResponse
    {
        $input = $request->validate(['to_state' => ['required', 'in:available,maintenance,retired']]);
        $result = app(MaintainRoom::class)->transition($this->actor(), AcademicRoom::query()->findOrFail($roomId), $input['to_state'], $this->idempotencyKey('academic.room.transition'));

        return response()->json(['status' => 'transitioned', ...$result]);
    }

    public function resizeRoom(Request $request, string $roomId): JsonResponse
    {
        $input = $request->validate(['capacity' => ['required', 'integer', 'min:1', 'max:10000']]);
        $result = app(MaintainRoom::class)->resize($this->actor(), AcademicRoom::query()->findOrFail($roomId), (int) $input['capacity'], $this->idempotencyKey('academic.room.resize'));

        return response()->json(['status' => 'resized', ...$result]);
    }

    public function endAssignment(Request $request, string $assignmentId): JsonResponse
    {
        $input = $request->validate(['effective_to' => ['required', 'date'], 'reason' => ['required', 'string', 'max:1000']]);
        $result = app(MaintainTeacherAssignment::class)->endAssignment($this->actor(), TeacherAssignment::query()->findOrFail($assignmentId), CarbonImmutable::parse($input['effective_to']), $input['reason'], $this->idempotencyKey('academic.teacher.end'));

        return response()->json(['status' => 'ended', ...$result]);
    }

    public function extendAssignment(Request $request, string $assignmentId): JsonResponse
    {
        $input = $request->validate(['effective_to' => ['required', 'date'], 'reason' => ['required', 'string', 'max:1000']]);
        $result = app(MaintainTeacherAssignment::class)->extendAssignment($this->actor(), TeacherAssignment::query()->findOrFail($assignmentId), CarbonImmutable::parse($input['effective_to']), $input['reason'], $this->idempotencyKey('academic.teacher.extend'));

        return response()->json(['status' => 'extended', ...$result]);
    }

    public function handoverAssignment(Request $request, string $assignmentId): JsonResponse
    {
        $input = $request->validate([
            'successor_teacher_person_id' => ['required', 'string'], 'handover_on' => ['required', 'date'], 'reason' => ['required', 'string', 'max:1000'],
        ]);
        $result = app(MaintainTeacherAssignment::class)->handoverAssignment($this->actor(), TeacherAssignment::query()->findOrFail($assignmentId), $input['successor_teacher_person_id'], CarbonImmutable::parse($input['handover_on']), $input['reason'], $this->idempotencyKey('academic.teacher.handover'));

        return response()->json(['status' => 'handed_over', ...$result]);
    }

    public function assignTeacherSkill(Request $request, string $assignmentId): JsonResponse
    {
        $input = $request->validate(['skill_id' => ['required', 'string']]);
        $result = app(MaintainTeacherAssignment::class)->assignSkill($this->actor(), TeacherAssignment::query()->findOrFail($assignmentId), $input['skill_id'], $this->idempotencyKey('academic.teacher.assign_skill'));

        return response()->json(['status' => 'assigned', ...$result], 201);
    }

    public function transitionEnrollment(Request $request, string $enrollmentId, string $action): JsonResponse
    {
        $enrollment = Enrollment::query()->findOrFail($enrollmentId);
        $command = app(MaintainEnrollment::class);
        $key = $this->idempotencyKey('academic.enrollment.'.$action);
        $result = match ($action) {
            'freeze' => $command->freeze($this->actor(), $enrollment, $request->validate(['reason' => ['required', 'string', 'max:1000']])['reason'], $key),
            'unfreeze' => $command->unfreeze($this->actor(), $enrollment, $key),
            'withdraw' => $command->withdraw($this->actor(), $enrollment, $request->validate(['reason' => ['required', 'string', 'max:1000']])['reason'], $key),
            'complete' => $this->completeEnrollmentCommand($request, $command, $enrollment, $key),
            'transfer' => $this->transferEnrollmentCommand($request, $command, $enrollment, $key),
            default => abort(422, 'Unsupported enrollment action.'),
        };

        return response()->json(['status' => 'transitioned', ...$result]);
    }

    /** @return array{enrollment_id: string, lifecycle_state: string, correlation_id: string} */
    private function completeEnrollmentCommand(Request $request, MaintainEnrollment $command, Enrollment $enrollment, string $key): array
    {
        $input = $request->validate(['basis' => ['required', 'string', 'max:1000'], 'evidence_kind' => ['nullable', 'in:assessment_result,progression_decision'], 'evidence_id' => ['nullable', 'string', 'required_with:evidence_kind']]);

        return $command->complete($this->actor(), $enrollment, $input['basis'], $this->optional($input['evidence_kind'] ?? null), $this->optional($input['evidence_id'] ?? null), $key);
    }

    /** @return array{enrollment_id: string, previous_enrollment_id: string, correlation_id: string} */
    private function transferEnrollmentCommand(Request $request, MaintainEnrollment $command, Enrollment $enrollment, string $key): array
    {
        $input = $request->validate(['target_class_id' => ['required', 'string'], 'offering_id' => ['nullable', 'string']]);

        return $command->transfer($this->actor(), $enrollment, $input['target_class_id'], $key, $this->optional($input['offering_id'] ?? null));
    }

    public function expireWaitlist(Request $request, string $entryId): JsonResponse
    {
        $result = app(ManageClassWaitlist::class)->expire($this->actor(), ClassWaitlistEntry::query()->findOrFail($entryId), $this->idempotencyKey('academic.waitlist.expire'));

        return response()->json(['status' => 'expired', ...$result]);
    }

    public function proposeGraduation(Request $request): JsonResponse
    {
        $input = $request->validate([
            'student_id' => ['required', 'string'], 'program_version_id' => ['required', 'string'],
            'outcome' => ['required', 'in:eligible,not_eligible'], 'basis' => ['required', 'string', 'max:1000'],
        ]);
        $result = app(DecideGraduation::class)->propose($this->actor(), $input['student_id'], $input['program_version_id'], $input['outcome'], $input['basis'], $this->idempotencyKey('academic.graduation.propose'));

        return response()->json(['status' => 'proposed', ...$result], 201);
    }

    public function transitionGraduation(Request $request, string $decisionId, string $action): JsonResponse
    {
        $decision = GraduationDecision::query()->findOrFail($decisionId);
        $command = app(DecideGraduation::class);
        $key = $this->idempotencyKey('academic.graduation.'.$action);
        $result = match ($action) {
            'review' => $command->review($this->actor(), $decision, $key),
            'approve' => $command->approve($this->actor(), $decision, $key),
            'reject' => $command->reject($this->actor(), $decision, $key),
            default => abort(422, 'Unsupported graduation action.'),
        };

        return response()->json(['status' => 'transitioned', ...$result]);
    }

    public function issueCertificate(Request $request, string $decisionId): JsonResponse
    {
        $result = app(DecideGraduation::class)->issueCertificate($this->actor(), GraduationDecision::query()->findOrFail($decisionId), $this->idempotencyKey('academic.certificate.issue'));

        return response()->json(['status' => 'issued', ...$result], 201);
    }

    public function issueTranscript(Request $request): JsonResponse
    {
        $input = $request->validate(['student_id' => ['required', 'string'], 'program_version_id' => ['required', 'string']]);
        $result = app(IssueTranscript::class)->issue($this->actor(), $input['student_id'], $input['program_version_id'], $this->idempotencyKey('academic.transcript.issue'));

        return response()->json(['status' => 'issued', ...$result], 201);
    }

    public function fileAppeal(Request $request): JsonResponse
    {
        $input = $request->validate([
            'student_id' => ['nullable', 'string'], 'subject_type' => ['required', 'in:assessment_result,progression_decision,placement_profile'],
            'subject_id' => ['required', 'string'], 'reason' => ['required', 'string', 'max:1000'],
        ]);
        $result = app(ManageAcademicAppeal::class)->file($this->actor(), (string) ($input['student_id'] ?? ''), $input['subject_type'], $input['subject_id'], $input['reason'], $this->idempotencyKey('academic.appeal.file'));

        return response()->json(['status' => 'filed', ...$result], 201);
    }

    public function transitionAppeal(Request $request, string $appealId, string $action): JsonResponse
    {
        $appeal = AcademicAppeal::query()->findOrFail($appealId);
        $command = app(ManageAcademicAppeal::class);
        $key = $this->idempotencyKey('academic.appeal.'.$action);
        $result = match ($action) {
            'investigate' => $command->investigate($this->actor(), $appeal, $key),
            'resolve' => $command->resolve($this->actor(), $appeal, $request->validate(['outcome' => ['required', 'string', 'max:500'], 'outcome_evidence' => ['required', 'string', 'max:1000']])['outcome'], $request->input('outcome_evidence'), $key),
            'reject' => $command->reject($this->actor(), $appeal, $request->validate(['outcome' => ['required', 'string', 'max:500'], 'outcome_evidence' => ['required', 'string', 'max:1000']])['outcome'], $request->input('outcome_evidence'), $key),
            'escalate' => $command->escalate($this->actor(), $appeal, $key),
            'close' => $command->close($this->actor(), $appeal, $key),
            default => abort(422, 'Unsupported appeal action.'),
        };

        return response()->json(['status' => 'transitioned', ...$result]);
    }

    public function assignAppeal(Request $request, string $appealId): JsonResponse
    {
        $input = $request->validate(['reviewer_person_id' => ['required', 'string']]);
        $result = app(ManageAcademicAppeal::class)->assign($this->actor(), AcademicAppeal::query()->findOrFail($appealId), $input['reviewer_person_id'], $this->idempotencyKey('academic.appeal.assign'));

        return response()->json(['status' => 'assigned', ...$result]);
    }

    private function optional(?string $value): ?string
    {
        return $value !== null && $value !== '' ? $value : null;
    }

    private function organizationIdForBranch(string $branchId): ?string
    {
        $branch = Branch::query()->find($branchId);
        if ($branch === null) {
            return null;
        }
        $organizationId = $branch->structureScope()->organizationId;

        return $organizationId !== '' ? $organizationId : null;
    }

    private function campusIdForBranch(string $branchId): ?string
    {
        $branch = Branch::query()->find($branchId);

        return $branch?->structureScope()->campusId;
    }
}
