<?php

declare(strict_types=1);

namespace Tests\Feature\Academic;

use App\Modules\Academic\Commands\MaintainAcademicStructure;
use App\Modules\Academic\Commands\MaintainClass;
use App\Modules\Academic\Commands\MaintainEnrollment;
use App\Modules\Academic\Commands\RecordAttendance;
use App\Modules\Academic\Models\AcademicPeriod;
use App\Modules\Academic\Models\AttendanceFact;
use App\Modules\Academic\Models\ClassModel;
use App\Modules\Academic\Models\ClassSession;
use App\Modules\Academic\Models\Enrollment;
use App\Modules\Academic\Models\Program;
use App\Modules\Academic\Queries\ClassRosterQuery;
use App\Modules\Admissions\Commands\DecideAdmission;
use App\Modules\Admissions\Commands\EnrollAdmittedApplicant;
use App\Modules\Admissions\Commands\RegisterApplicant;
use App\Modules\Admissions\Models\Applicant;
use App\Modules\Students\Commands\TransitionStudentStatus;
use App\Modules\Students\Models\Student;
use App\Support\Errors\AuthorizationDenied;
use App\Support\Errors\BusinessRejection;
use Carbon\CarbonImmutable;
use Illuminate\Database\QueryException;
use Illuminate\Support\Facades\DB;
use Tests\Concerns\BuildsActors;
use Tests\TestCase;

final class AcademicDeliveryFeatureTest extends TestCase
{
    use BuildsActors;

    private string $classId;

    private string $teacherPersonId = 'acad-teacher-1';

    protected function setUp(): void
    {
        parent::setUp();
        $officer = $this->academicOfficer();
        $this->personWithAuthority($this->teacherPersonId, []);

        $program = app(MaintainAcademicStructure::class)->defineProgram($officer, 'IELTS Preparation', 'prog-key-1');
        $version = app(MaintainAcademicStructure::class)->publishVersion($officer, Program::query()->findOrFail($program['program_id']), 'initial rules', 'prog-key-2');
        $period = app(MaintainAcademicStructure::class)->definePeriod($officer, 'Fall 2026', new CarbonImmutable('2026-09-01'), new CarbonImmutable('2026-12-18'), 'period-key-1');
        app(MaintainAcademicStructure::class)->transitionPeriod($officer, AcademicPeriod::query()->findOrFail($period['period_id']), 'published', 'period-key-2');

        $class = app(MaintainClass::class)->defineClass($officer, $version['version_id'], $period['period_id'], 2, 'class-key-1');
        $this->classId = $class['class_id'];
        app(MaintainClass::class)->assignTeacher($officer, ClassModel::query()->findOrFail($this->classId), $this->teacherPersonId, new CarbonImmutable('2026-09-01'), null, 'class-key-2');
    }

    private function activeClassId(): string
    {
        $officer = $this->academicOfficer();
        app(MaintainClass::class)->transition($officer, ClassModel::query()->findOrFail($this->classId), 'published', 'class-key-3');
        app(MaintainClass::class)->transition($officer, ClassModel::query()->findOrFail($this->classId), 'active', 'class-key-4');

        return $this->classId;
    }

    private function newStudent(string $personId): string
    {
        $this->personWithAuthority($personId, []);
        $registered = app(RegisterApplicant::class)->register($this->admissionsClerk('acad-clerk-a'), $personId, 'Program', 'acad-reg-'.$personId);
        /** @var Applicant $applicant */
        $applicant = Applicant::query()->findOrFail($registered['applicant_id']);
        app(DecideAdmission::class)->decide(
            $this->admissionsClerk('acad-clerk-a'), $this->admissionsReviewer('acad-review-a'), $this->admissionsApprover('acad-approve-a'),
            $applicant, true, 'meets policy', 'ev/acad', 'acad-dec-'.$personId,
        );

        return app(EnrollAdmittedApplicant::class)->convert($this->admissionsApprover('acad-approve-a'), $applicant, 'acad-conv-'.$personId)['student_id'];
    }

    public function test_program_versions_are_immutable_and_periods_publish_close(): void
    {
        $officer = $this->academicOfficer('acad-officer-2');
        $program = app(MaintainAcademicStructure::class)->defineProgram($officer, 'TOEFL Fundamentals', 'prog-key-3');
        /** @var Program $programRow */
        $programRow = Program::query()->findOrFail($program['program_id']);
        $first = app(MaintainAcademicStructure::class)->publishVersion($officer, $programRow, 'v1 rules', 'prog-key-4');
        $second = app(MaintainAcademicStructure::class)->publishVersion($officer, $programRow, 'v2 rules', 'prog-key-5');

        $this->assertSame(1, $first['version_no']);
        $this->assertSame(2, $second['version_no']);
        $this->assertSame('published', $programRow->refresh()->lifecycle_state);
        $this->expectException(QueryException::class);
        DB::statement('UPDATE program_versions SET summary = ? WHERE id = ?', ['tampered', $first['version_id']]);
    }

    public function test_class_requires_published_period_teacher_and_follows_chain(): void
    {
        $officer = $this->academicOfficer('acad-officer-3');
        /** @var ClassModel $class */
        $class = ClassModel::query()->findOrFail($this->classId);

        try {
            app(MaintainClass::class)->transition($officer, $class, 'active', 'class-key-6');
            $this->fail('planned -> active must be rejected');
        } catch (BusinessRejection $rejection) {
            $this->assertSame('academic.class_transition_forbidden', $rejection->errorCode());
        }

        app(MaintainClass::class)->transition($officer, $class, 'published', 'class-key-7');

        $teacherless = app(MaintainClass::class)->defineClass($officer, $class->program_version_id, $class->period_id, 10, 'class-key-8');
        try {
            app(MaintainClass::class)->transition($officer, ClassModel::query()->findOrFail($teacherless['class_id']), 'published', 'class-key-9');
            app(MaintainClass::class)->transition($officer, ClassModel::query()->findOrFail($teacherless['class_id']), 'active', 'class-key-10');
            $this->fail('a class without a teacher must not activate');
        } catch (BusinessRejection $rejection) {
            $this->assertSame('academic.class_needs_teacher', $rejection->errorCode());
        }

        app(MaintainClass::class)->transition($officer, $class, 'active', 'class-key-11');
        $this->assertSame('active', $class->refresh()->lifecycle_state);

        $session = app(MaintainClass::class)->scheduleSession($officer, $class, new CarbonImmutable('2026-09-07'), '09:00:00', '11:00:00', 'session-key-1');
        $this->assertDatabaseHas('class_sessions', ['id' => $session['session_id'], 'class_id' => $class->id]);

        app(MaintainClass::class)->transition($officer, $class, 'cancelled', 'class-key-12');
        $this->assertDatabaseHas('classes', ['id' => $class->id, 'lifecycle_state' => 'cancelled']);
        $this->assertDatabaseHas('audit_events', ['operation' => 'academic.class.transition', 'target_type' => 'class', 'target_id' => $class->id]);
    }

    public function test_enrollment_chain_capacity_duplicate_seat_and_transfer(): void
    {
        $officer = $this->academicOfficer('acad-officer-4');
        $clerk = $this->enrollmentClerk('acad-clerk-4');
        $classId = $this->activeClassId();
        $studentA = $this->newStudent('acad-person-a');
        $studentB = $this->newStudent('acad-person-b');
        $studentC = $this->newStudent('acad-person-c');

        $seatA = app(MaintainEnrollment::class)->request($clerk, $studentA, $classId, 'enr-key-1');
        try {
            app(MaintainEnrollment::class)->activate($clerk, Enrollment::query()->findOrFail($seatA['enrollment_id']), 'enr-key-2');
            $this->fail('the clerk must not activate seats');
        } catch (AuthorizationDenied $denial) {
            $this->assertSame('academic.enrollment_denied', $denial->errorCode());
        }

        app(MaintainEnrollment::class)->activate($officer, Enrollment::query()->findOrFail($seatA['enrollment_id']), 'enr-key-3');
        try {
            app(MaintainEnrollment::class)->request($clerk, $studentA, $classId, 'enr-key-4');
            $this->fail('a duplicate seat must be rejected');
        } catch (BusinessRejection $rejection) {
            $this->assertSame('academic.enrollment_seat_exists', $rejection->errorCode());
        }

        $seatB = app(MaintainEnrollment::class)->request($clerk, $studentB, $classId, 'enr-key-5');
        app(MaintainEnrollment::class)->activate($officer, Enrollment::query()->findOrFail($seatB['enrollment_id']), 'enr-key-6');

        $seatC = app(MaintainEnrollment::class)->request($clerk, $studentC, $classId, 'enr-key-7');
        try {
            app(MaintainEnrollment::class)->activate($officer, Enrollment::query()->findOrFail($seatC['enrollment_id']), 'enr-key-8');
            $this->fail('capacity of two must be exhausted');
        } catch (BusinessRejection $rejection) {
            $this->assertSame('academic.class_full', $rejection->errorCode());
        }
        $this->assertDatabaseHas('enrollments', ['id' => $seatC['enrollment_id'], 'lifecycle_state' => 'requested']);

        // second class for transfer
        $class2 = app(MaintainClass::class)->defineClass($officer, ClassModel::query()->findOrFail($classId)->program_version_id, ClassModel::query()->findOrFail($classId)->period_id, 5, 'class2-key-1');
        $this->personWithAuthority('acad-teacher-2', []);
        app(MaintainClass::class)->assignTeacher($officer, ClassModel::query()->findOrFail($class2['class_id']), 'acad-teacher-2', new CarbonImmutable('2026-09-01'), null, 'class2-key-2');
        app(MaintainClass::class)->transition($officer, ClassModel::query()->findOrFail($class2['class_id']), 'published', 'class2-key-3');
        app(MaintainClass::class)->transition($officer, ClassModel::query()->findOrFail($class2['class_id']), 'active', 'class2-key-4');

        $transferred = app(MaintainEnrollment::class)->transfer($officer, Enrollment::query()->findOrFail($seatA['enrollment_id']), $class2['class_id'], 'enr-key-9');
        $this->assertDatabaseHas('enrollments', ['id' => $seatA['enrollment_id'], 'lifecycle_state' => 'transferred']);
        $this->assertDatabaseHas('enrollments', ['id' => $transferred['enrollment_id'], 'lifecycle_state' => 'requested', 'class_id' => $class2['class_id']]);

        $roster = (new ClassRosterQuery)->roster($classId);
        $this->assertSame(1, $roster['active_seats']);
        $this->assertCount(1, $roster['teachers']);
        $this->assertDatabaseHas('audit_events', ['operation' => 'academic.enrollment.transfer']);
    }

    public function test_suspended_student_cannot_be_enrolled(): void
    {
        $officer = $this->academicOfficer('acad-officer-5');
        $clerk = $this->enrollmentClerk('acad-clerk-5');
        $classId = $this->activeClassId();
        $studentId = $this->newStudent('acad-person-d');
        app(TransitionStudentStatus::class)->suspend($this->studentManager('stu-mgr-acad'), Student::query()->findOrFail($studentId), 'attendance', 'enr-key-10');

        $this->expectException(BusinessRejection::class);
        $this->expectExceptionMessage('enrollment requires a currently active student');
        app(MaintainEnrollment::class)->request($clerk, $studentId, $classId, 'enr-key-11');
    }

    public function test_attendance_records_and_corrections_are_append_only(): void
    {
        $officer = $this->academicOfficer('acad-officer-6');
        $classId = $this->activeClassId();
        $studentId = $this->newStudent('acad-person-e');
        $seat = app(MaintainEnrollment::class)->request($this->enrollmentClerk('acad-clerk-6'), $studentId, $classId, 'enr-key-12');
        app(MaintainEnrollment::class)->activate($officer, Enrollment::query()->findOrFail($seat['enrollment_id']), 'enr-key-13');
        $session = app(MaintainClass::class)->scheduleSession($officer, ClassModel::query()->findOrFail($classId), new CarbonImmutable('2026-09-08'), '09:00:00', '11:00:00', 'session-key-2');
        /** @var ClassSession $sessionRow */
        $sessionRow = ClassSession::query()->findOrFail($session['session_id']);

        $fact = app(RecordAttendance::class)->record($officer, $sessionRow, Enrollment::query()->findOrFail($seat['enrollment_id']), 'present', 'att-key-1');
        $correction = app(RecordAttendance::class)->correct($officer, AttendanceFact::query()->findOrFail($fact['fact_id']), 'late', 'arrived 20 minutes late, verified at desk', 'att-key-2');

        $this->assertDatabaseHas('attendance_facts', ['id' => $correction['fact_id'], 'corrects_id' => $fact['fact_id'], 'status' => 'late', 'reason' => 'arrived 20 minutes late, verified at desk']);
        $this->assertDatabaseHas('attendance_facts', ['id' => $fact['fact_id'], 'status' => 'present']);

        try {
            app(RecordAttendance::class)->correct($officer, AttendanceFact::query()->findOrFail($fact['fact_id']), 'absent', '', 'att-key-3');
            $this->fail('a correction without reason must be rejected');
        } catch (BusinessRejection $rejection) {
            $this->assertSame('academic.attendance_correction_reason', $rejection->errorCode());
        }

        $this->expectException(QueryException::class);
        DB::statement("UPDATE attendance_facts SET status = 'absent' WHERE id = ?", [$fact['fact_id']]);
    }

    public function test_attendance_rejects_inactive_enrollment_and_cancelled_class(): void
    {
        $officer = $this->academicOfficer('acad-officer-7');
        $classId = $this->activeClassId();
        $studentId = $this->newStudent('acad-person-f');
        $seat = app(MaintainEnrollment::class)->request($this->enrollmentClerk('acad-clerk-7'), $studentId, $classId, 'enr-key-14');
        app(MaintainEnrollment::class)->activate($officer, Enrollment::query()->findOrFail($seat['enrollment_id']), 'enr-key-15');
        $session = app(MaintainClass::class)->scheduleSession($officer, ClassModel::query()->findOrFail($classId), new CarbonImmutable('2026-09-09'), '09:00:00', '11:00:00', 'session-key-3');
        /** @var ClassSession $sessionRow */
        $sessionRow = ClassSession::query()->findOrFail($session['session_id']);

        app(MaintainEnrollment::class)->freeze($officer, Enrollment::query()->findOrFail($seat['enrollment_id']), 'enr-key-16');
        try {
            app(RecordAttendance::class)->record($officer, $sessionRow, Enrollment::query()->findOrFail($seat['enrollment_id']), 'present', 'att-key-4');
            $this->fail('a frozen enrollment must not take attendance');
        } catch (BusinessRejection $rejection) {
            $this->assertSame('academic.attendance_enrollment_not_active', $rejection->errorCode());
        }
        try {
            app(MaintainEnrollment::class)->transfer($officer, Enrollment::query()->findOrFail($seat['enrollment_id']), 'x', 'enr-key-17');
            $this->fail('frozen -> transferred must be rejected');
        } catch (BusinessRejection $rejection) {
            $this->assertSame('academic.enrollment_transition_forbidden', $rejection->errorCode());
        }
        $this->assertDatabaseHas('enrollments', ['id' => $seat['enrollment_id'], 'lifecycle_state' => 'frozen']);
    }

    public function test_unprivileged_actor_cannot_define_structure(): void
    {
        $nobody = $this->actorWithoutAnyCapability('acad-nobody');

        $this->expectException(AuthorizationDenied::class);
        $this->expectExceptionMessage('no active authority grants academic.structure');
        app(MaintainAcademicStructure::class)->definePeriod($nobody, 'Rogue Period', new CarbonImmutable('2027-01-01'), new CarbonImmutable('2027-06-01'), 'period-key-9');

        $this->assertDatabaseHas('audit_events', ['operation' => 'academic.period.define.denied', 'actor_id' => 'acad-nobody']);
        $this->assertDatabaseMissing('academic_periods', ['name' => 'Rogue Period']);
    }
}
