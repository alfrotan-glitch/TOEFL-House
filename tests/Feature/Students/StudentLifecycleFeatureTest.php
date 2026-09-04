<?php

declare(strict_types=1);

namespace Tests\Feature\Students;

use App\Modules\Admissions\Commands\EnrollAdmittedApplicant;
use App\Modules\Admissions\Commands\RegisterApplicant;
use App\Modules\Admissions\Models\Applicant;
use App\Modules\Organization\Models\Branch;
use App\Modules\Students\Commands\MaintainStudentCommunicationPreference;
use App\Modules\Students\Commands\ManageStudentHold;
use App\Modules\Students\Commands\TransferStudentHomeBranch;
use App\Modules\Students\Commands\TransitionStudentStatus;
use App\Modules\Students\Models\Student;
use App\Modules\Students\Queries\StudentLifecycleQuery;
use App\Modules\Students\Queries\StudentRecordQuery;
use App\Support\Errors\AuthorizationDenied;
use App\Support\Errors\BusinessRejection;
use App\Support\Identifiers\RandomIdentifier;
use Illuminate\Database\QueryException;
use Illuminate\Support\Facades\DB;
use Tests\Concerns\BuildsActors;
use Tests\Concerns\DecidesAdmissions;
use Tests\TestCase;

final class StudentLifecycleFeatureTest extends TestCase
{
    use BuildsActors;
    use DecidesAdmissions;

    private Student $student;

    protected function setUp(): void
    {
        parent::setUp();
        $this->personWithAuthority('life-person-1', []);
        $registered = app(RegisterApplicant::class)->register($this->admissionsClerk('life-clerk'), 'life-person-1', 'Program', 'life-reg-1');
        $applicant = Applicant::query()->findOrFail($registered['applicant_id']);
        $this->runAdmissionDecision(
            $this->admissionsClerk('life-clerk'),
            $this->admissionsReviewer('life-review'),
            $this->admissionsApprover('life-approve'),
            $applicant, true, 'meets policy', 'ev/life', 'life-dec-1',
        );
        $converted = app(EnrollAdmittedApplicant::class)->convert($this->admissionsApprover('life-approve'), $applicant, 'life-conv-1');
        $this->student = Student::query()->findOrFail($converted['student_id']);
    }

    private function branch(string $suffix, string $lifecycle = 'active'): Branch
    {
        /** @var Branch $branch */
        $branch = Branch::query()->create([
            'id' => RandomIdentifier::new(),
            'name' => 'Lifecycle Branch '.$suffix,
            'lifecycle_state' => $lifecycle,
        ]);

        return $branch;
    }

    public function test_transfer_assigns_origin_advances_home_and_keeps_history(): void
    {
        $manager = $this->grantedActor('life-transfer-1', ['students.transfer']);
        $first = $this->branch('first');
        $second = $this->branch('second');

        $firstResult = app(TransferStudentHomeBranch::class)->transfer($manager, $this->student, $first->id, 'initial assignment', 'life-tr-k1');
        $this->assertSame($first->id, trim((string) $firstResult['to_branch_id']));
        $this->assertNull($firstResult['from_branch_id']);

        $studentAfterFirst = $this->student->fresh();
        $this->assertSame($first->id, trim((string) $studentAfterFirst?->originating_branch_id));
        $this->assertSame($first->id, trim((string) $studentAfterFirst?->current_home_branch_id));
        $this->assertSame(1, DB::table('student_branch_transfers')->where('student_id', $this->student->id)->count());

        $secondResult = app(TransferStudentHomeBranch::class)->transfer($manager, $this->student, $second->id, 'relocation', 'life-tr-k2');
        $this->assertSame($first->id, trim((string) $secondResult['from_branch_id']));

        $studentAfterSecond = $this->student->fresh();
        $this->assertSame($first->id, trim((string) $studentAfterSecond?->originating_branch_id), 'origin must never advance');
        $this->assertSame($second->id, trim((string) $studentAfterSecond?->current_home_branch_id));

        $record = (new StudentRecordQuery)->studentRecord($this->student->id);
        $this->assertSame($first->id, trim((string) $record['originating_branch_id']));
        $this->assertSame($second->id, trim((string) $record['current_home_branch_id']));
        $this->assertSame(2, count($record['branch_transfers']));

        $this->assertDatabaseHas('audit_events', ['operation' => 'students.transfer', 'target_type' => 'student']);
    }

    public function test_transfer_rejects_same_inactive_or_missing_branch_and_required_reason(): void
    {
        $manager = $this->grantedActor('life-transfer-2', ['students.transfer']);
        $active = $this->branch('active');
        $closed = $this->branch('closed', 'closed');

        app(TransferStudentHomeBranch::class)->transfer($manager, $this->student, $active->id, 'initial', 'life-tr-k3');

        try {
            app(TransferStudentHomeBranch::class)->transfer($manager, $this->student, $active->id, 'same branch', 'life-tr-k4');
            $this->fail('a same-branch transfer must be rejected');
        } catch (BusinessRejection $rejection) {
            $this->assertSame('students.transfer_same_branch', $rejection->errorCode());
        }

        try {
            app(TransferStudentHomeBranch::class)->transfer($manager, $this->student, $closed->id, 'closed target', 'life-tr-k5');
            $this->fail('a closed branch must be rejected');
        } catch (BusinessRejection $rejection) {
            $this->assertSame('students.transfer_branch_inactive', $rejection->errorCode());
        }

        try {
            app(TransferStudentHomeBranch::class)->transfer($manager, $this->student, RandomIdentifier::new(), 'unknown target', 'life-tr-k6');
            $this->fail('an unknown branch must be rejected');
        } catch (BusinessRejection $rejection) {
            $this->assertSame('students.transfer_branch_inactive', $rejection->errorCode());
        }

        try {
            app(TransferStudentHomeBranch::class)->transfer($manager, $this->student, $this->branch('reason')->id, '', 'life-tr-k7');
            $this->fail('an empty reason must be rejected');
        } catch (BusinessRejection $rejection) {
            $this->assertSame('students.transfer_reason', $rejection->errorCode());
        }
    }

    public function test_transfer_requires_the_active_status(): void
    {
        $manager = $this->studentManager('life-transfer-status-mgr');
        $reactivator = $this->studentReactivator('life-transfer-status-react');
        $transferor = $this->grantedActor('life-transfer-4', ['students.transfer']);
        $branch = $this->branch('status-gated');

        app(TransitionStudentStatus::class)->suspend($manager, $this->student, 'probation', 'life-trans-suspend-1');
        try {
            app(TransferStudentHomeBranch::class)->transfer($transferor, $this->student, $branch->id, 'while suspended', 'life-trans-while-suspended');
            $this->fail('a branch transfer requires the active status');
        } catch (BusinessRejection $rejection) {
            $this->assertSame('students.transfer_requires_active', $rejection->errorCode());
        }

        app(TransitionStudentStatus::class)->reactivate($reactivator, $this->student, 'cleared', 'life-trans-reactivate-1');
        $result = app(TransferStudentHomeBranch::class)->transfer($transferor, $this->student, $branch->id, 'after reactivation', 'life-trans-after-reactivate');
        $this->assertSame($branch->id, trim((string) $result['to_branch_id']));
    }

    public function test_transfer_is_authorized_and_history_is_append_only(): void
    {
        try {
            app(TransferStudentHomeBranch::class)->transfer($this->actorWithoutAnyCapability('life-nobody-1'), $this->student, $this->branch('unauthorized')->id, 'no permission', 'life-tr-k8');
            $this->fail('transfer without the capability must be denied');
        } catch (AuthorizationDenied $denial) {
            $this->assertSame('students.transfer_denied', $denial->errorCode());
        }

        $manager = $this->grantedActor('life-transfer-3', ['students.transfer']);
        $branch = $this->branch('append');
        app(TransferStudentHomeBranch::class)->transfer($manager, $this->student, $branch->id, 'history fact', 'life-tr-k9');

        $this->expectException(QueryException::class);
        DB::statement('UPDATE student_branch_transfers SET reason = ? WHERE student_id = ?', ['rewritten', $this->student->id]);
    }

    public function test_hold_freeze_resume_is_append_only_and_status_gated(): void
    {
        $holder = $this->grantedActor('life-holder-1', ['students.hold']);
        $manager = $this->studentManager('life-mgr-1');
        $reactivator = $this->studentReactivator('life-react-1');

        app(ManageStudentHold::class)->freeze($holder, $this->student, 'medical freeze', 'life-hold-k1');
        $this->assertTrue((new StudentLifecycleQuery)->for($this->student)['holds']['open']);
        $this->assertDatabaseHas('student_hold_events', ['student_id' => $this->student->id, 'action' => 'freeze']);

        try {
            app(ManageStudentHold::class)->freeze($holder, $this->student, 'double freeze', 'life-hold-k2');
            $this->fail('re-freezing an open hold must be rejected');
        } catch (BusinessRejection $rejection) {
            $this->assertSame('students.hold_already_frozen', $rejection->errorCode());
        }

        app(ManageStudentHold::class)->resume($holder, $this->student, 'hold cleared', 'life-hold-k3');
        $this->assertFalse((new StudentLifecycleQuery)->for($this->student)['holds']['open']);

        try {
            app(ManageStudentHold::class)->resume($holder, $this->student, 'resume without freeze', 'life-hold-k4');
            $this->fail('resuming a non-frozen student must be rejected');
        } catch (BusinessRejection $rejection) {
            $this->assertSame('students.hold_not_frozen', $rejection->errorCode());
        }

        $this->assertSame(2, DB::table('student_hold_events')->where('student_id', $this->student->id)->count());

        // A held (or any non-active) student cannot open or resume a hold.
        app(TransitionStudentStatus::class)->suspend($manager, $this->student, 'probation', 'life-hold-k5');
        try {
            app(ManageStudentHold::class)->freeze($holder, $this->student, 'freeze while suspended', 'life-hold-k6');
            $this->fail('a hold requires the active status');
        } catch (BusinessRejection $rejection) {
            $this->assertSame('students.hold_requires_active', $rejection->errorCode());
        }

        app(TransitionStudentStatus::class)->reactivate($reactivator, $this->student, 'returned', 'life-hold-k7');
        app(ManageStudentHold::class)->freeze($holder, $this->student, 'freeze after return', 'life-hold-k8');
        $this->assertTrue((new StudentLifecycleQuery)->for($this->student)['holds']['open']);

        $this->expectException(QueryException::class);
        DB::statement('DELETE FROM student_hold_events WHERE student_id = ?', [$this->student->id]);
    }

    public function test_hold_requires_capability_and_reason(): void
    {
        try {
            app(ManageStudentHold::class)->freeze($this->actorWithoutAnyCapability('life-nobody-2'), $this->student, 'no permission', 'life-hold-k9');
            $this->fail('hold without the capability must be denied');
        } catch (AuthorizationDenied $denial) {
            $this->assertSame('students.hold_denied', $denial->errorCode());
        }

        $holder = $this->grantedActor('life-holder-2', ['students.hold']);
        try {
            app(ManageStudentHold::class)->freeze($holder, $this->student, '', 'life-hold-k10');
            $this->fail('a hold requires a reason');
        } catch (BusinessRejection $rejection) {
            $this->assertSame('students.hold_reason', $rejection->errorCode());
        }
    }

    public function test_communication_preference_upserts_per_channel_and_validates(): void
    {
        $manager = $this->grantedActor('life-comm-1', ['students.communication']);

        $created = app(MaintainStudentCommunicationPreference::class)->setPreference($manager, $this->student, 'email', true, 'life-comm-k1');
        $this->assertSame('email', $created['channel']);
        $this->assertTrue($created['enabled']);
        $this->assertSame(1, DB::table('student_communication_preferences')->where('student_id', $this->student->id)->count());

        $updated = app(MaintainStudentCommunicationPreference::class)->setPreference($manager, $this->student, 'email', false, 'life-comm-k2');
        $this->assertFalse($updated['enabled']);
        $this->assertSame($created['preference_id'], $updated['preference_id'], 'per-channel state must be an upsert, not a duplicate fact');
        $this->assertSame(1, DB::table('student_communication_preferences')->where('student_id', $this->student->id)->count());

        app(MaintainStudentCommunicationPreference::class)->setPreference($manager, $this->student, 'whatsapp', true, 'life-comm-k3');
        $this->assertSame(2, DB::table('student_communication_preferences')->where('student_id', $this->student->id)->count());

        $record = (new StudentRecordQuery)->studentRecord($this->student->id);
        $this->assertCount(2, $record['communication_preferences']);

        try {
            app(MaintainStudentCommunicationPreference::class)->setPreference($manager, $this->student, 'fax', true, 'life-comm-k4');
            $this->fail('an unknown channel must be rejected');
        } catch (BusinessRejection $rejection) {
            $this->assertSame('students.communication_channel_unknown', $rejection->errorCode());
        }

        try {
            app(MaintainStudentCommunicationPreference::class)->setPreference($this->actorWithoutAnyCapability('life-nobody-3'), $this->student, 'email', true, 'life-comm-k5');
            $this->fail('communication preference without the capability must be denied');
        } catch (AuthorizationDenied $denial) {
            $this->assertSame('students.communication_denied', $denial->errorCode());
        }

        $this->assertDatabaseHas('audit_events', ['operation' => 'students.communication.set', 'target_type' => 'student_communication_preference']);
    }
}
