<?php

declare(strict_types=1);

namespace Tests\Feature\Students;

use App\Modules\Admissions\Commands\EnrollAdmittedApplicant;
use App\Modules\Admissions\Commands\RegisterApplicant;
use App\Modules\Admissions\Models\Applicant;
use App\Modules\Students\Commands\MaintainGuardianRelationship;
use App\Modules\Students\Commands\TransitionStudentStatus;
use App\Modules\Students\Models\GuardianRelationship;
use App\Modules\Students\Models\Student;
use App\Modules\Students\Queries\StudentRecordQuery;
use App\Support\Errors\AuthorizationDenied;
use App\Support\Errors\BusinessRejection;
use Illuminate\Database\QueryException;
use Illuminate\Support\Facades\DB;
use Tests\Concerns\BuildsActors;
use Tests\Concerns\DecidesAdmissions;
use Tests\TestCase;

final class StudentStatusFeatureTest extends TestCase
{
    use BuildsActors;
    use DecidesAdmissions;

    private Student $student;

    protected function setUp(): void
    {
        parent::setUp();
        $this->personWithAuthority('stu-person-1', []);
        $registered = app(RegisterApplicant::class)->register($this->admissionsClerk('stu-clerk'), 'stu-person-1', 'Program', 'stu-reg-1');
        /** @var Applicant $applicant */
        $applicant = Applicant::query()->findOrFail($registered['applicant_id']);
        $this->runAdmissionDecision(
            $this->admissionsClerk('stu-clerk'),
            $this->admissionsReviewer('stu-review'),
            $this->admissionsApprover('stu-approve'),
            $applicant, true, 'meets policy', 'ev/stu', 'stu-dec-1',
        );
        $converted = app(EnrollAdmittedApplicant::class)->convert($this->admissionsApprover('stu-approve'), $applicant, 'stu-conv-1');
        $this->student = Student::query()->findOrFail($converted['student_id']);
    }

    public function test_status_moves_suspend_reactivate_with_history_rows_and_no_silent_overwrite(): void
    {
        $manager = $this->studentManager('stu-mgr-a');
        $reactivator = $this->studentReactivator('stu-react-a');

        app(TransitionStudentStatus::class)->suspend($manager, $this->student, 'attendance probation', 'stu-key-1');
        $this->assertSame('suspended', (new StudentRecordQuery)->studentRecord($this->student->id)['status']);

        try {
            app(TransitionStudentStatus::class)->suspend($manager, $this->student, 'again', 'stu-key-2');
            $this->fail('suspended -> suspended must be rejected');
        } catch (BusinessRejection $rejection) {
            $this->assertSame('students.transition_forbidden', $rejection->errorCode());
        }

        try {
            app(TransitionStudentStatus::class)->reactivate($manager, $this->student, 'manager self reactivation', 'stu-key-3');
            $this->fail('reactivation requires the approval capability');
        } catch (AuthorizationDenied $denial) {
            $this->assertSame('students.status_denied', $denial->errorCode());
        }

        app(TransitionStudentStatus::class)->reactivate($reactivator, $this->student, 'probation cleared', 'stu-key-4');
        $this->assertSame('active', (new StudentRecordQuery)->studentRecord($this->student->id)['status']);

        $this->assertSame(3, DB::table('student_statuses')->where('student_id', $this->student->id)->count(), 'history rows accumulate, nothing is overwritten');
        $this->assertDatabaseHas('audit_events', ['operation' => 'students.status.suspended', 'target_type' => 'student_status']);
    }

    public function test_withdraw_reactivate_and_terminal_paths(): void
    {
        $manager = $this->studentManager('stu-mgr-b');
        $reactivator = $this->studentReactivator('stu-react-b');

        app(TransitionStudentStatus::class)->withdraw($manager, $this->student, 'family relocation', 'stu-key-5');
        app(TransitionStudentStatus::class)->reactivate($reactivator, $this->student, 'returned', 'stu-key-6');
        app(TransitionStudentStatus::class)->complete($manager, $this->student, 'program finished', 'stu-key-7');
        app(TransitionStudentStatus::class)->graduate($manager, $this->student, 'certified', 'stu-key-8');

        $record = (new StudentRecordQuery)->studentRecord($this->student->id);
        $this->assertSame('alumni', $record['status']);

        $this->expectException(BusinessRejection::class);
        $this->expectExceptionMessage('transition alumni -> active is not allowed');
        app(TransitionStudentStatus::class)->reactivate($reactivator, $this->student, 'no return from alumni', 'stu-key-9');
    }

    public function test_status_history_is_append_only_even_against_raw_sql(): void
    {
        $this->expectException(QueryException::class);
        DB::statement("UPDATE student_statuses SET status = 'withdrawn' WHERE student_id = ?", [$this->student->id]);
    }

    public function test_guardian_relationship_verify_revoke_and_permissions(): void
    {
        $manager = $this->studentManager('stu-mgr-c');
        $this->personWithAuthority('stu-guardian-1', []);
        $recorded = app(MaintainGuardianRelationship::class)->record(
            $manager, $this->student, 'stu-guardian-1', 'father', ['view-academic', 'receive-communication'], 'guard-key-1',
        );
        /** @var GuardianRelationship $relationship */
        $relationship = GuardianRelationship::query()->findOrFail($recorded['relationship_id']);

        $unverifiedView = (new StudentRecordQuery)->studentRecord($this->student->id);
        $this->assertSame([], $unverifiedView['guardians'], 'an unverified relationship carries no permissions');

        app(MaintainGuardianRelationship::class)->verify($manager, $relationship, 'guard-key-2');
        $verifiedView = (new StudentRecordQuery)->studentRecord($this->student->id);
        $this->assertCount(1, $verifiedView['guardians']);
        $this->assertSame(['view-academic', 'receive-communication'], $verifiedView['guardians'][0]['permissions']);

        app(MaintainGuardianRelationship::class)->revoke($manager, $relationship, 'guard-key-3');
        $revokedView = (new StudentRecordQuery)->studentRecord($this->student->id);
        $this->assertSame([], $revokedView['guardians']);
        $this->assertDatabaseHas('guardian_relationships', ['id' => $relationship->id, 'lifecycle_state' => 'revoked']);
    }

    public function test_guardian_self_relationship_and_duplicates_are_rejected(): void
    {
        $manager = $this->studentManager('stu-mgr-d');

        try {
            app(MaintainGuardianRelationship::class)->record($manager, $this->student, 'stu-person-1', 'self', ['view-academic'], 'guard-key-4');
            $this->fail('a student cannot be their own guardian');
        } catch (BusinessRejection $rejection) {
            $this->assertSame('students.guardian_self', $rejection->errorCode());
        }

        $this->personWithAuthority('stu-guardian-2', []);
        app(MaintainGuardianRelationship::class)->record($manager, $this->student, 'stu-guardian-2', 'mother', ['view-academic'], 'guard-key-5');
        $this->expectException(BusinessRejection::class);
        $this->expectExceptionMessage('already has an open row');
        app(MaintainGuardianRelationship::class)->record($manager, $this->student, 'stu-guardian-2', 'mother', ['view-financial'], 'guard-key-6');
    }

    public function test_unprivileged_actor_cannot_transition_status(): void
    {
        $nobody = $this->actorWithoutAnyCapability('stu-nobody');

        $this->expectException(AuthorizationDenied::class);
        $this->expectExceptionMessage('no active authority grants students.manage');
        app(TransitionStudentStatus::class)->suspend($nobody, $this->student, 'unauthorized attempt', 'stu-key-10');

        $this->assertDatabaseHas('audit_events', ['operation' => 'students.status.denied', 'actor_id' => 'stu-nobody']);
        $this->assertSame('active', (new StudentRecordQuery)->studentRecord($this->student->id)['status']);
    }
}
