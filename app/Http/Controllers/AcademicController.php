<?php

declare(strict_types=1);

namespace App\Http\Controllers;

use App\Modules\Academic\Commands\DecideGraduation;
use App\Modules\Academic\Commands\DecideProgression;
use App\Modules\Academic\Commands\IssueTranscript;
use App\Modules\Academic\Commands\MaintainAcademicStructure;
use App\Modules\Academic\Commands\MaintainClass;
use App\Modules\Academic\Commands\MaintainEnrollment;
use App\Modules\Academic\Commands\MaintainSkill;
use App\Modules\Academic\Commands\ManageAcademicAppeal;
use App\Modules\Academic\Commands\ManageAcademicOffering;
use App\Modules\Academic\Commands\ManageAssessmentResult;
use App\Modules\Academic\Commands\RecordAttendance;
use App\Modules\Academic\Models\AcademicAppeal;
use App\Modules\Academic\Models\AcademicPeriod;
use App\Modules\Academic\Models\AssessmentAttempt;
use App\Modules\Academic\Models\AssessmentResult;
use App\Modules\Academic\Models\BranchAvailability;
use App\Modules\Academic\Models\ClassModel;
use App\Modules\Academic\Models\ClassSession;
use App\Modules\Academic\Models\Enrollment;
use App\Modules\Academic\Models\GraduationDecision;
use App\Modules\Academic\Models\Offering;
use App\Modules\Academic\Models\Program;
use App\Modules\Academic\Models\ProgramVersion;
use App\Modules\Academic\Models\ProgramVersionLevel;
use App\Modules\Academic\Models\ProgressionDecision;
use App\Modules\Academic\Models\ResultCorrection;
use App\Modules\Academic\Models\Skill;
use App\Modules\Academic\Models\TeacherAssignment;
use App\Modules\Academic\Models\Transcript;
use App\Modules\Identity\Models\Person;
use App\Modules\Organization\Models\Branch;
use App\Modules\Students\Models\Student;
use Carbon\CarbonImmutable;
use Illuminate\Http\RedirectResponse;
use Illuminate\Http\Request;
use Illuminate\View\View;

/**
 * Academic console: the structure (programs, periods, classes, skills,
 * teacher assignments), the session calendar, and attendance recording with
 * corrections. Session scheduling and attendance delegate to the academic
 * module commands, which own authorization and the delivery evidence.
 */
final class AcademicController extends Controller
{
    public function index(): View
    {
        return view('academic.index', [
            'programs' => Program::query()->orderBy('name')->limit(100)->get(),
            'periods' => AcademicPeriod::query()->orderBy('starts_on')->limit(100)->get(),
            'skills' => Skill::query()->orderBy('key')->limit(100)->get(),
            'classes' => ClassModel::query()->orderBy('id')->limit(100)->get(),
            'assignments' => TeacherAssignment::query()->orderBy('id')->limit(100)->get(),
            'students' => Student::query()->orderBy('student_code')->limit(300)->get(),
            'activeEnrollments' => Enrollment::query()->where('lifecycle_state', 'active')->orderBy('id')->limit(300)->get(),
            'attempts' => AssessmentAttempt::query()->where('lifecycle_state', 'submitted')->orderByDesc('id')->limit(200)->get(),
            'results' => AssessmentResult::query()->whereIn('lifecycle_state', ['scored', 'moderated', 'approved'])->orderByDesc('id')->limit(200)->get(),
            'corrections' => ResultCorrection::query()->where('lifecycle_state', ResultCorrection::STATE_PROPOSED)->orderByDesc('id')->limit(200)->get(),
            'programVersions' => ProgramVersion::query()->orderBy('id')->limit(200)->get(),
            'graduations' => GraduationDecision::query()->whereIn('lifecycle_state', ['proposed', 'reviewed', 'approved'])->orderByDesc('id')->limit(200)->get(),
            'requestedEnrollments' => Enrollment::query()->where('lifecycle_state', 'requested')->orderBy('id')->limit(200)->get(),
            'frozenEnrollments' => Enrollment::query()->where('lifecycle_state', 'frozen')->orderBy('id')->limit(200)->get(),
            'progressions' => ProgressionDecision::query()->whereIn('lifecycle_state', ['proposed', 'reviewed'])->orderBy('id')->limit(200)->get(),
            'appeals' => AcademicAppeal::query()->whereIn('lifecycle_state', ['open', 'assigned', 'investigating', 'escalated', 'resolved', 'rejected'])->orderByDesc('id')->limit(200)->get(),
            'releasedResults' => AssessmentResult::query()->where('lifecycle_state', 'released')->orderByDesc('id')->limit(200)->get(),
            'approvedProgressions' => ProgressionDecision::query()->where('lifecycle_state', 'approved')->orderBy('id')->limit(200)->get(),
            'people' => Person::query()->where('verification_state', 'verified')->orderBy('legal_name')->limit(300)->get(),
            'transcripts' => Transcript::query()->orderByDesc('issued_at')->limit(100)->get(),
            'branches' => Branch::query()->orderBy('name')->limit(100)->get(),
            'levels' => ProgramVersionLevel::query()->orderBy('program_version_id')->orderBy('ordinal')->limit(300)->get(),
            'availabilities' => BranchAvailability::query()->orderBy('id')->limit(200)->get(),
            'offerings' => Offering::query()->orderBy('id')->limit(200)->get(),
        ]);
    }

    public function sessions(): View
    {
        return view('academic.sessions', [
            'sessions' => ClassSession::query()->orderByDesc('scheduled_on')->limit(200)->get(),
            'classes' => ClassModel::query()->where('lifecycle_state', 'active')->orderBy('id')->get(),
            'skills' => Skill::query()->where('lifecycle_state', 'active')->orderBy('key')->get(),
            'enrollments' => Enrollment::query()->where('lifecycle_state', 'active')->orderBy('class_id')->limit(1000)->get(),
        ]);
    }

    public function scheduleSession(Request $request): RedirectResponse
    {
        $input = $request->validate([
            'class_id' => ['required', 'string'],
            'scheduled_on' => ['required', 'date'],
            'starts_at' => ['required', 'string', 'regex:/^\d{2}:\d{2}$/'],
            'ends_at' => ['required', 'string', 'regex:/^\d{2}:\d{2}$/'],
            'skill_id' => ['nullable', 'string'],
        ]);

        $skillId = $input['skill_id'] ?? null;

        app(MaintainClass::class)->scheduleSession(
            $this->actor(),
            ClassModel::query()->findOrFail($input['class_id']),
            CarbonImmutable::parse($input['scheduled_on']),
            $input['starts_at'],
            $input['ends_at'],
            $this->idempotencyKey('academic.schedule'),
            ($skillId !== null && $skillId !== '') ? $skillId : null,
        );

        return redirect()->route('academic.sessions')->with('success', 'Session scheduled.');
    }

    public function recordAttendance(Request $request, string $sessionId): RedirectResponse
    {
        $input = $request->validate([
            'enrollment_id' => ['required', 'string'],
            'status' => ['required', 'in:present,late,absent,excused'],
        ]);

        app(RecordAttendance::class)->record(
            $this->actor(),
            ClassSession::query()->findOrFail($sessionId),
            Enrollment::query()->findOrFail($input['enrollment_id']),
            $input['status'],
            $this->idempotencyKey('academic.attendance'),
        );

        return redirect()->route('academic.sessions')->with('success', 'Attendance fact recorded.');
    }

    public function requestEnrollment(Request $request): RedirectResponse
    {
        $input = $request->validate([
            'student_id' => ['required', 'string'],
            'class_id' => ['required', 'string'],
            'offering_id' => ['nullable', 'string'],
        ]);

        $offeringId = ($input['offering_id'] ?? '') !== '' ? (string) $input['offering_id'] : null;
        app(MaintainEnrollment::class)->request(
            $this->actor(),
            $input['student_id'],
            $input['class_id'],
            $this->idempotencyKey('academic.enrollment.request'),
            $offeringId,
        );

        return redirect()->route('academic.index')->with('success', 'Seat requested; it takes effect once an approver activates it.');
    }

    public function activateEnrollment(Request $request, string $enrollmentId): RedirectResponse
    {
        app(MaintainEnrollment::class)->activate(
            $this->actor(),
            Enrollment::query()->findOrFail($enrollmentId),
            $this->idempotencyKey('academic.enrollment.activate'),
        );

        return redirect()->route('academic.index')->with('success', 'Seat activated.');
    }

    public function freezeEnrollment(Request $request, string $enrollmentId): RedirectResponse
    {
        $input = $request->validate([
            'reason' => ['required', 'string', 'max:1000'],
        ]);

        app(MaintainEnrollment::class)->freeze(
            $this->actor(),
            Enrollment::query()->findOrFail($enrollmentId),
            $input['reason'],
            $this->idempotencyKey('academic.enrollment.freeze'),
        );

        return redirect()->route('academic.index')->with('success', 'Seat frozen with its reason recorded.');
    }

    public function unfreezeEnrollment(Request $request, string $enrollmentId): RedirectResponse
    {
        app(MaintainEnrollment::class)->unfreeze(
            $this->actor(),
            Enrollment::query()->findOrFail($enrollmentId),
            $this->idempotencyKey('academic.enrollment.unfreeze'),
        );

        return redirect()->route('academic.index')->with('success', 'Seat returned to active under a fresh financial gate.');
    }

    public function withdrawEnrollment(Request $request, string $enrollmentId): RedirectResponse
    {
        $input = $request->validate([
            'reason' => ['required', 'string', 'max:1000'],
        ]);

        app(MaintainEnrollment::class)->withdraw(
            $this->actor(),
            Enrollment::query()->findOrFail($enrollmentId),
            $input['reason'],
            $this->idempotencyKey('academic.enrollment.withdraw'),
        );

        return redirect()->route('academic.index')->with('success', 'Seat withdrawn with its reason recorded.');
    }

    public function completeEnrollment(Request $request, string $enrollmentId): RedirectResponse
    {
        $input = $request->validate([
            'basis' => ['required', 'string', 'max:1000'],
            'evidence_kind' => ['nullable', 'string', 'in:assessment_result,progression_decision'],
            'evidence_id' => ['nullable', 'string', 'required_with:evidence_kind'],
        ]);

        $evidenceKind = $input['evidence_kind'] ?? null;
        $evidenceId = $input['evidence_id'] ?? null;

        app(MaintainEnrollment::class)->complete(
            $this->actor(),
            Enrollment::query()->findOrFail($enrollmentId),
            $input['basis'],
            ($evidenceKind !== null && $evidenceKind !== '') ? $evidenceKind : null,
            ($evidenceId !== null && $evidenceId !== '') ? $evidenceId : null,
            $this->idempotencyKey('academic.enrollment.complete'),
        );

        return redirect()->route('academic.index')->with('success', 'Seat completed with its basis and evidence pinned.');
    }

    public function proposeProgression(Request $request): RedirectResponse
    {
        $input = $request->validate([
            'student_id' => ['required', 'string'],
            'class_id' => ['required', 'string'],
            'outcome' => ['required', 'in:advance,repeat'],
            'reason' => ['required', 'string', 'max:1000'],
        ]);

        app(DecideProgression::class)->propose(
            $this->actor(),
            $input['student_id'],
            $input['class_id'],
            $input['outcome'],
            $input['reason'],
            $this->idempotencyKey('academic.progression.propose'),
        );

        return redirect()->route('academic.index')->with('success', 'Progression proposed; it takes effect once reviewed and approved by distinct signers.');
    }

    public function reviewProgression(Request $request, string $decisionId): RedirectResponse
    {
        app(DecideProgression::class)->review(
            $this->actor(),
            ProgressionDecision::query()->findOrFail($decisionId),
            $this->idempotencyKey('academic.progression.review'),
        );

        return redirect()->route('academic.index')->with('success', 'Progression reviewed.');
    }

    public function approveProgression(Request $request, string $decisionId): RedirectResponse
    {
        app(DecideProgression::class)->approve(
            $this->actor(),
            ProgressionDecision::query()->findOrFail($decisionId),
            $this->idempotencyKey('academic.progression.approve'),
        );

        return redirect()->route('academic.index')->with('success', 'Progression approved.');
    }

    public function defineProgram(Request $request): RedirectResponse
    {
        $input = $request->validate([
            'name' => ['required', 'string', 'max:160'],
        ]);

        app(MaintainAcademicStructure::class)->defineProgram(
            $this->actor(),
            $input['name'],
            $this->idempotencyKey('academic.program.define'),
        );

        return redirect()->route('academic.index')->with('success', 'Program defined.');
    }

    public function publishProgramVersion(Request $request, string $programId): RedirectResponse
    {
        $input = $request->validate([
            'summary' => ['required', 'string', 'max:1000'],
        ]);

        app(MaintainAcademicStructure::class)->publishVersion(
            $this->actor(),
            Program::query()->findOrFail($programId),
            $input['summary'],
            $this->idempotencyKey('academic.version.publish'),
        );

        return redirect()->route('academic.index')->with('success', 'Program version published (immutable).');
    }

    public function definePeriod(Request $request): RedirectResponse
    {
        $input = $request->validate([
            'name' => ['required', 'string', 'max:160'],
            'starts_on' => ['required', 'date'],
            'ends_on' => ['required', 'date', 'after_or_equal:starts_on'],
        ]);

        app(MaintainAcademicStructure::class)->definePeriod(
            $this->actor(),
            $input['name'],
            CarbonImmutable::parse($input['starts_on']),
            CarbonImmutable::parse($input['ends_on']),
            $this->idempotencyKey('academic.period.define'),
        );

        return redirect()->route('academic.index')->with('success', 'Academic period defined.');
    }

    public function transitionPeriod(Request $request, string $periodId): RedirectResponse
    {
        $input = $request->validate([
            'to_state' => ['required', 'in:published,closed'],
        ]);

        app(MaintainAcademicStructure::class)->transitionPeriod(
            $this->actor(),
            AcademicPeriod::query()->findOrFail($periodId),
            $input['to_state'],
            $this->idempotencyKey('academic.period.transition'),
        );

        return redirect()->route('academic.index')->with('success', 'Academic period transitioned.');
    }

    public function registerSkill(Request $request): RedirectResponse
    {
        $input = $request->validate([
            'key' => ['required', 'string', 'max:60'],
            'name' => ['required', 'string', 'max:160'],
        ]);

        app(MaintainSkill::class)->register(
            $this->actor(),
            $input['key'],
            $input['name'],
            $this->idempotencyKey('academic.skill.register'),
        );

        return redirect()->route('academic.index')->with('success', 'Skill registered.');
    }

    public function retireSkill(Request $request, string $skillId): RedirectResponse
    {
        app(MaintainSkill::class)->retire(
            $this->actor(),
            Skill::query()->findOrFail($skillId),
            $this->idempotencyKey('academic.skill.retire'),
        );

        return redirect()->route('academic.index')->with('success', 'Skill retired.');
    }

    public function defineClass(Request $request): RedirectResponse
    {
        $input = $request->validate([
            'program_version_id' => ['required', 'string'],
            'period_id' => ['required', 'string'],
            'capacity' => ['required', 'integer', 'min:1', 'max:10000'],
        ]);

        app(MaintainClass::class)->defineClass(
            $this->actor(),
            $input['program_version_id'],
            $input['period_id'],
            (int) $input['capacity'],
            $this->idempotencyKey('academic.class.define'),
        );

        return redirect()->route('academic.index')->with('success', 'Class defined (planned). Assign a teacher and publish it to open seats.');
    }

    public function transitionClass(Request $request, string $classId): RedirectResponse
    {
        $input = $request->validate([
            'to_state' => ['required', 'in:published,active,completed,cancelled'],
        ]);

        app(MaintainClass::class)->transition(
            $this->actor(),
            ClassModel::query()->findOrFail($classId),
            $input['to_state'],
            $this->idempotencyKey('academic.class.transition'),
        );

        return redirect()->route('academic.index')->with('success', 'Class state moved to '.$input['to_state'].'.');
    }

    public function assignTeacher(Request $request): RedirectResponse
    {
        $input = $request->validate([
            'class_id' => ['required', 'string'],
            'teacher_person_id' => ['required', 'string'],
            'effective_from' => ['required', 'date'],
            'effective_to' => ['nullable', 'date', 'after:effective_from'],
            'skill_id' => ['nullable', 'string'],
        ]);

        $effectiveTo = $input['effective_to'] ?? null;

        $result = app(MaintainClass::class)->assignTeacher(
            $this->actor(),
            ClassModel::query()->findOrFail($input['class_id']),
            $input['teacher_person_id'],
            CarbonImmutable::parse($input['effective_from']),
            ($effectiveTo !== null && $effectiveTo !== '') ? CarbonImmutable::parse((string) $effectiveTo) : null,
            $this->idempotencyKey('academic.teacher.assign'),
        );

        if (! empty($input['skill_id'])) {
            app(MaintainClass::class)->assignSkill(
                $this->actor(),
                TeacherAssignment::query()->findOrFail($result['assignment_id']),
                $input['skill_id'],
                $this->idempotencyKey('academic.teacher.assign_skill'),
            );
        }

        return redirect()->route('academic.index')->with('success', 'Teacher assigned to the class.');
    }

    public function submitAssessmentAttempt(Request $request): RedirectResponse
    {
        $input = $request->validate([
            'enrollment_id' => ['required', 'string'],
            'kind' => ['required', 'in:placement,assessment'],
            'evidence_ref' => ['required', 'string', 'max:500'],
        ]);

        app(ManageAssessmentResult::class)->submitAttempt(
            $this->actor(),
            Enrollment::query()->findOrFail($input['enrollment_id']),
            $input['kind'],
            $input['evidence_ref'],
            $this->idempotencyKey('academic.attempt.submit'),
        );

        return redirect()->route('academic.index')->with('success', 'Attempt submitted; it can now be scored.');
    }

    public function scoreAttempt(Request $request, string $attemptId): RedirectResponse
    {
        $input = $request->validate([
            'score' => ['required', 'numeric', 'money', 'min:0', 'max:9999.99'],
        ]);

        app(ManageAssessmentResult::class)->score(
            $this->actor(),
            AssessmentAttempt::query()->findOrFail($attemptId),
            $input['score'],
            $this->idempotencyKey('academic.result.score'),
        );

        return redirect()->route('academic.index')->with('success', 'Result recorded; it moves scored to moderated to approved to released.');
    }

    public function moderateResult(Request $request, string $resultId): RedirectResponse
    {
        app(ManageAssessmentResult::class)->moderate(
            $this->actor(),
            AssessmentResult::query()->findOrFail($resultId),
            $this->idempotencyKey('academic.result.moderate'),
        );

        return redirect()->route('academic.index')->with('success', 'Result moderated.');
    }

    public function approveResult(Request $request, string $resultId): RedirectResponse
    {
        app(ManageAssessmentResult::class)->approve(
            $this->actor(),
            AssessmentResult::query()->findOrFail($resultId),
            $this->idempotencyKey('academic.result.approve'),
        );

        return redirect()->route('academic.index')->with('success', 'Result approved.');
    }

    public function releaseResult(Request $request, string $resultId): RedirectResponse
    {
        app(ManageAssessmentResult::class)->release(
            $this->actor(),
            AssessmentResult::query()->findOrFail($resultId),
            $this->idempotencyKey('academic.result.release'),
        );

        return redirect()->route('academic.index')->with('success', 'Result released; only released results exist for the student.');
    }

    public function proposeCorrection(Request $request, string $resultId): RedirectResponse
    {
        $input = $request->validate([
            'score' => ['required', 'numeric', 'money', 'min:0', 'max:9999.99'],
            'reason' => ['required', 'string', 'max:1000'],
        ]);

        app(ManageAssessmentResult::class)->proposeCorrection(
            $this->actor(),
            AssessmentResult::query()->findOrFail($resultId),
            $input['score'],
            $input['reason'],
            $this->idempotencyKey('academic.result.correction.propose'),
        );

        return redirect()->route('academic.index')->with('success', 'Correction proposed; it records only when a distinct approver approves it.');
    }

    public function approveCorrection(Request $request, string $correctionId): RedirectResponse
    {
        app(ManageAssessmentResult::class)->approveCorrection(
            $this->actor(),
            ResultCorrection::query()->findOrFail($correctionId),
            $this->idempotencyKey('academic.result.correction.approve'),
        );

        return redirect()->route('academic.index')->with('success', 'Correction approved; the original result is closed as corrected.');
    }

    public function proposeGraduation(Request $request): RedirectResponse
    {
        $input = $request->validate([
            'student_id' => ['required', 'string'],
            'program_version_id' => ['required', 'string'],
            'outcome' => ['required', 'in:eligible,not_eligible'],
            'basis' => ['required', 'string', 'max:1000'],
        ]);

        app(DecideGraduation::class)->propose(
            $this->actor(),
            $input['student_id'],
            $input['program_version_id'],
            $input['outcome'],
            $input['basis'],
            $this->idempotencyKey('academic.graduation.propose'),
        );

        return redirect()->route('academic.index')->with('success', 'Graduation proposed; it takes effect once reviewed and approved by distinct signers.');
    }

    public function reviewGraduation(Request $request, string $decisionId): RedirectResponse
    {
        app(DecideGraduation::class)->review(
            $this->actor(),
            GraduationDecision::query()->findOrFail($decisionId),
            $this->idempotencyKey('academic.graduation.review'),
        );

        return redirect()->route('academic.index')->with('success', 'Graduation reviewed.');
    }

    public function approveGraduation(Request $request, string $decisionId): RedirectResponse
    {
        app(DecideGraduation::class)->approve(
            $this->actor(),
            GraduationDecision::query()->findOrFail($decisionId),
            $this->idempotencyKey('academic.graduation.approve'),
        );

        return redirect()->route('academic.index')->with('success', 'Graduation approved.');
    }

    public function rejectGraduation(Request $request, string $decisionId): RedirectResponse
    {
        app(DecideGraduation::class)->reject(
            $this->actor(),
            GraduationDecision::query()->findOrFail($decisionId),
            $this->idempotencyKey('academic.graduation.reject'),
        );

        return redirect()->route('academic.index')->with('success', 'Graduation rejected.');
    }

    public function issueCertificate(Request $request, string $decisionId): RedirectResponse
    {
        app(DecideGraduation::class)->issueCertificate(
            $this->actor(),
            GraduationDecision::query()->findOrFail($decisionId),
            $this->idempotencyKey('academic.certificate.issue'),
        );

        return redirect()->route('academic.index')->with('success', 'Certificate issued with its unique serial.');
    }

    public function issueTranscript(Request $request): RedirectResponse
    {
        $input = $request->validate([
            'student_id' => ['required', 'string'],
            'program_version_id' => ['required', 'string'],
        ]);

        app(IssueTranscript::class)->issue(
            $this->actor(),
            $input['student_id'],
            $input['program_version_id'],
            $this->idempotencyKey('academic.transcript.issue'),
        );

        return redirect()->route('academic.index')->with('success', 'Official transcript issued and frozen with its content hash.');
    }

    public function declareAvailability(Request $request): RedirectResponse
    {
        $input = $request->validate([
            'branch_id' => ['required', 'string'],
            'program_version_level_id' => ['required', 'string'],
            'academic_period_id' => ['required', 'string'],
        ]);

        app(MaintainAcademicStructure::class)->declareBranchAvailability(
            $this->actor(),
            $input['branch_id'],
            $input['program_version_level_id'],
            $input['academic_period_id'],
            $this->idempotencyKey('academic.availability.declare'),
        );

        return redirect()->route('academic.index')->with('success', 'Branch availability declared.');
    }

    public function openOffering(Request $request): RedirectResponse
    {
        $input = $request->validate([
            'branch_id' => ['required', 'string'],
            'program_version_level_id' => ['required', 'string'],
            'academic_period_id' => ['required', 'string'],
            'capacity' => ['required', 'integer', 'min:1', 'max:10000'],
        ]);

        app(MaintainAcademicStructure::class)->openOffering(
            $this->actor(),
            $input['branch_id'],
            $input['program_version_level_id'],
            $input['academic_period_id'],
            (int) $input['capacity'],
            $this->idempotencyKey('academic.offering.open'),
        );

        return redirect()->route('academic.index')->with('success', 'Offering opened.');
    }

    public function closeAvailability(Request $request, string $availabilityId): RedirectResponse
    {
        app(ManageAcademicOffering::class)->closeAvailability(
            $this->actor(),
            BranchAvailability::query()->findOrFail($availabilityId),
            $this->idempotencyKey('academic.availability.close'),
        );

        return redirect()->route('academic.index')->with('success', 'Availability closed.');
    }

    public function reopenAvailability(Request $request, string $availabilityId): RedirectResponse
    {
        app(ManageAcademicOffering::class)->reopenAvailability(
            $this->actor(),
            BranchAvailability::query()->findOrFail($availabilityId),
            $this->idempotencyKey('academic.availability.reopen'),
        );

        return redirect()->route('academic.index')->with('success', 'Availability reopened.');
    }

    public function closeOffering(Request $request, string $offeringId): RedirectResponse
    {
        app(ManageAcademicOffering::class)->closeOffering(
            $this->actor(),
            Offering::query()->findOrFail($offeringId),
            $this->idempotencyKey('academic.offering.close'),
        );

        return redirect()->route('academic.index')->with('success', 'Offering closed.');
    }

    public function reopenOffering(Request $request, string $offeringId): RedirectResponse
    {
        app(ManageAcademicOffering::class)->reopenOffering(
            $this->actor(),
            Offering::query()->findOrFail($offeringId),
            $this->idempotencyKey('academic.offering.reopen'),
        );

        return redirect()->route('academic.index')->with('success', 'Offering reopened.');
    }

    public function cancelOffering(Request $request, string $offeringId): RedirectResponse
    {
        app(ManageAcademicOffering::class)->cancelOffering(
            $this->actor(),
            Offering::query()->findOrFail($offeringId),
            $this->idempotencyKey('academic.offering.cancel'),
        );

        return redirect()->route('academic.index')->with('success', 'Offering cancelled.');
    }

    public function completeOffering(Request $request, string $offeringId): RedirectResponse
    {
        app(ManageAcademicOffering::class)->completeOffering(
            $this->actor(),
            Offering::query()->findOrFail($offeringId),
            $this->idempotencyKey('academic.offering.complete'),
        );

        return redirect()->route('academic.index')->with('success', 'Offering completed.');
    }

    public function resizeOffering(Request $request, string $offeringId): RedirectResponse
    {
        $input = $request->validate([
            'capacity' => ['required', 'integer', 'min:1', 'max:10000'],
        ]);

        app(ManageAcademicOffering::class)->resizeCapacity(
            $this->actor(),
            Offering::query()->findOrFail($offeringId),
            (int) $input['capacity'],
            $this->idempotencyKey('academic.offering.resize'),
        );

        return redirect()->route('academic.index')->with('success', 'Offering capacity resized.');
    }

    public function fileAppeal(Request $request): RedirectResponse
    {
        $input = $request->validate([
            'student_id' => ['nullable', 'string'],
            'subject_type' => ['required', 'in:assessment_result,progression_decision,placement_profile'],
            'subject_id' => ['required', 'string'],
            'reason' => ['required', 'string', 'max:1000'],
        ]);

        app(ManageAcademicAppeal::class)->file(
            $this->actor(),
            (string) ($input['student_id'] ?? ''),
            $input['subject_type'],
            $input['subject_id'],
            $input['reason'],
            $this->idempotencyKey('academic.appeal.file'),
        );

        return redirect()->route('academic.index')->with('success', 'Appeal filed; it opens the independent review chain.');
    }

    public function assignAppeal(Request $request, string $appealId): RedirectResponse
    {
        $input = $request->validate([
            'reviewer_person_id' => ['required', 'string'],
        ]);

        app(ManageAcademicAppeal::class)->assign(
            $this->actor(),
            AcademicAppeal::query()->findOrFail($appealId),
            $input['reviewer_person_id'],
            $this->idempotencyKey('academic.appeal.assign'),
        );

        return redirect()->route('academic.index')->with('success', 'Appeal assigned to the reviewer.');
    }

    public function investigateAppeal(Request $request, string $appealId): RedirectResponse
    {
        app(ManageAcademicAppeal::class)->investigate(
            $this->actor(),
            AcademicAppeal::query()->findOrFail($appealId),
            $this->idempotencyKey('academic.appeal.investigate'),
        );

        return redirect()->route('academic.index')->with('success', 'Appeal investigation opened.');
    }

    public function resolveAppeal(Request $request, string $appealId): RedirectResponse
    {
        $input = $request->validate([
            'outcome' => ['required', 'string', 'max:500'],
            'outcome_evidence' => ['required', 'string', 'max:1000'],
        ]);

        app(ManageAcademicAppeal::class)->resolve(
            $this->actor(),
            AcademicAppeal::query()->findOrFail($appealId),
            $input['outcome'],
            $input['outcome_evidence'],
            $this->idempotencyKey('academic.appeal.resolve'),
        );

        return redirect()->route('academic.index')->with('success', 'Appeal resolved with its outcome and evidence.');
    }

    public function rejectAppeal(Request $request, string $appealId): RedirectResponse
    {
        $input = $request->validate([
            'outcome' => ['required', 'string', 'max:500'],
            'outcome_evidence' => ['required', 'string', 'max:1000'],
        ]);

        app(ManageAcademicAppeal::class)->reject(
            $this->actor(),
            AcademicAppeal::query()->findOrFail($appealId),
            $input['outcome'],
            $input['outcome_evidence'],
            $this->idempotencyKey('academic.appeal.reject'),
        );

        return redirect()->route('academic.index')->with('success', 'Appeal rejected with its outcome and evidence.');
    }

    public function escalateAppeal(Request $request, string $appealId): RedirectResponse
    {
        app(ManageAcademicAppeal::class)->escalate(
            $this->actor(),
            AcademicAppeal::query()->findOrFail($appealId),
            $this->idempotencyKey('academic.appeal.escalate'),
        );

        return redirect()->route('academic.index')->with('success', 'Appeal escalated for re-assignment.');
    }

    public function closeAppeal(Request $request, string $appealId): RedirectResponse
    {
        app(ManageAcademicAppeal::class)->close(
            $this->actor(),
            AcademicAppeal::query()->findOrFail($appealId),
            $this->idempotencyKey('academic.appeal.close'),
        );

        return redirect()->route('academic.index')->with('success', 'Appeal closed; the decision record is final.');
    }
}
