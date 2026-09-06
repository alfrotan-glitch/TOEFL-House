<?php

declare(strict_types=1);

namespace Tests\Feature\Academic;

use App\Modules\Academic\Commands\DecideGraduation;
use App\Modules\Academic\Commands\DecideProgression;
use App\Modules\Academic\Commands\IssueTranscript;
use App\Modules\Academic\Commands\MaintainAcademicStructure;
use App\Modules\Academic\Commands\MaintainClass;
use App\Modules\Academic\Commands\MaintainEnrollment;
use App\Modules\Academic\Commands\MaintainRoom;
use App\Modules\Academic\Commands\ManageAcademicAppeal;
use App\Modules\Academic\Commands\ManageAcademicOffering;
use App\Modules\Academic\Commands\ManageAssessmentResult;
use App\Modules\Academic\Commands\ManageClassWaitlist;
use App\Modules\Academic\Commands\RecordAttendance;
use App\Modules\Academic\Models\AcademicAppeal;
use App\Modules\Academic\Models\AcademicPeriod;
use App\Modules\Academic\Models\AcademicRoom;
use App\Modules\Academic\Models\AssessmentAttempt;
use App\Modules\Academic\Models\AssessmentResult;
use App\Modules\Academic\Models\BranchAvailability;
use App\Modules\Academic\Models\ClassModel;
use App\Modules\Academic\Models\ClassSession;
use App\Modules\Academic\Models\ClassWaitlistEntry;
use App\Modules\Academic\Models\Enrollment;
use App\Modules\Academic\Models\Offering;
use App\Modules\Academic\Models\Program;
use App\Modules\Admissions\Commands\EnrollAdmittedApplicant;
use App\Modules\Admissions\Commands\RegisterApplicant;
use App\Modules\Admissions\Models\Applicant;
use App\Modules\Organization\Models\Branch;
use App\Modules\Students\Models\Student;
use App\Support\Authorization\Actor;
use App\Support\Errors\AuthorizationDenied;
use App\Support\Errors\BusinessRejection;
use App\Support\Identifiers\RandomIdentifier;
use Carbon\CarbonImmutable;
use Tests\Concerns\BuildsActors;
use Tests\Concerns\DecidesAdmissions;
use Tests\TestCase;

/**
 * Adversarial branch-isolation coverage (WP-ACAD-SCOPE): an officer scoped
 * to branch A is refused on every delivery verb touching branch-B records
 * — input-branch verbs, stored-record verbs, seat queues, attendance,
 * assessment, progression, graduation, transcripts, and appeals — while
 * org-wide authority and same-branch authority keep working, and unknown
 * branches fail closed.
 */
final class BranchIsolationAdversarialTest extends TestCase
{
    use BuildsActors;
    use DecidesAdmissions;

    private const CAPS = [
        'academic.structure', 'academic.schedule', 'academic.enroll', 'academic.enroll_approve',
        'academic.attendance', 'academic.assess', 'academic.moderate', 'academic.approve_result',
        'academic.release', 'academic.progression_propose', 'academic.progression_review',
        'academic.progression_approve', 'academic.completion', 'academic.completion_approve',
        'academic.certify', 'academic.transcript_issue', 'academic.appeal_manage',
    ];

    private string $branchA;

    private string $branchB;

    private string $levelId;

    private string $level2Id;

    private string $periodId;

    private string $programVersionId;

    private string $availabilityA;

    private string $availabilityB;

    private string $offeringA;

    private string $offeringB;

    private string $classId;

    private string $sessionId;

    private string $studentFree;

    private string $studentA;

    private string $studentB;

    private string $studentWaitB;

    private string $seatA;

    private string $seatB;

    private string $waitB;

    private string $releasedResultB;

    private string $moderatedResultA;

    protected function setUp(): void
    {
        parent::setUp();
        $structure = app(MaintainAcademicStructure::class);
        $org = $this->orgOfficer();

        $this->branchA = $this->newBranch('Isolation Branch A');
        $this->branchB = $this->newBranch('Isolation Branch B');

        $program = $structure->defineProgram($org, 'Isolation Intensive', 'iso-prog');
        $version = $structure->publishVersion($org, Program::query()->findOrFail($program['program_id']), 'Isolation v1', 'iso-ver');
        $this->programVersionId = $version['version_id'];
        $this->levelId = $structure->defineLevel($org, $this->programVersionId, 'iso-l1', 1, 'Iso One', 'A1', 'iso-lvl1')['level_id'];
        $this->level2Id = $structure->defineLevel($org, $this->programVersionId, 'iso-l2', 2, 'Iso Two', 'A2', 'iso-lvl2')['level_id'];

        $this->periodId = $structure->definePeriod($org, 'Isolation Term', new CarbonImmutable('2026-10-01'), new CarbonImmutable('2026-12-30'), 'iso-period')['period_id'];
        $structure->transitionPeriod($org, AcademicPeriod::query()->findOrFail($this->periodId), 'published', 'iso-period-pub');

        $this->availabilityA = $structure->declareBranchAvailability($org, $this->branchA, $this->levelId, $this->periodId, 'iso-avail-a')['availability_id'];
        $this->availabilityB = $structure->declareBranchAvailability($org, $this->branchB, $this->levelId, $this->periodId, 'iso-avail-b')['availability_id'];
        $this->offeringA = $structure->openOffering($org, $this->branchA, $this->levelId, $this->periodId, 4, 'iso-off-a')['offering_id'];
        $this->offeringB = $structure->openOffering($org, $this->branchB, $this->levelId, $this->periodId, 4, 'iso-off-b')['offering_id'];

        $this->classId = app(MaintainClass::class)->defineClass($org, $this->programVersionId, $this->periodId, 8, 'iso-class', $this->levelId)['class_id'];
        $teacher = $this->personWithAuthority('iso-teacher-1', [])->id;
        app(MaintainClass::class)->assignTeacher($org, ClassModel::query()->findOrFail($this->classId), $teacher, new CarbonImmutable('2026-09-01'), null, 'iso-class-teacher');
        app(MaintainClass::class)->transition($org, ClassModel::query()->findOrFail($this->classId), 'published', 'iso-class-pub');
        app(MaintainClass::class)->transition($org, ClassModel::query()->findOrFail($this->classId), 'active', 'iso-class-active');
        $this->sessionId = app(MaintainClass::class)->scheduleSession(
            $org, ClassModel::query()->findOrFail($this->classId), new CarbonImmutable('2026-10-05'), '09:00', '10:30', 'iso-session'
        )['session_id'];

        $this->studentA = $this->newStudent('iso-student-a');
        $this->studentB = $this->newStudent('iso-student-b');
        $this->studentFree = $this->newStudent('iso-student-free');
        $this->studentWaitB = $this->newStudent('iso-student-wait-b');
        // Provenance seeding: student B belongs to branch B. The isolation
        // boundary is exercised against this stored provenance.
        Student::query()->whereKey($this->studentB)->update(['current_home_branch_id' => $this->branchB]);

        $enroll = app(MaintainEnrollment::class);
        $this->seatA = $enroll->request($org, $this->studentA, $this->classId, 'iso-enr-a', $this->offeringA)['enrollment_id'];
        $enroll->activate($org, Enrollment::query()->findOrFail($this->seatA), 'iso-act-a');
        $this->seatB = $enroll->request($org, $this->studentB, $this->classId, 'iso-enr-b', $this->offeringB)['enrollment_id'];
        $enroll->activate($org, Enrollment::query()->findOrFail($this->seatB), 'iso-act-b');

        // Fill the branch-B offering so the queue can be exercised; the last
        // filler stays requested to exercise the activation gate as well.
        foreach (['iso-fill-1', 'iso-fill-2'] as $index => $personId) {
            $student = $this->newStudent($personId);
            $seat = $enroll->request($org, $student, $this->classId, 'iso-fill-enr-'.$index, $this->offeringB)['enrollment_id'];
            $enroll->activate($org, Enrollment::query()->findOrFail($seat), 'iso-fill-act-'.$index);
        }
        $fillerActive = $this->newStudent('iso-fill-3');
        $fillSeat = $enroll->request($org, $fillerActive, $this->classId, 'iso-fill-enr-3', $this->offeringB)['enrollment_id'];
        $enroll->activate($org, Enrollment::query()->findOrFail($fillSeat), 'iso-fill-act-3');

        $this->waitB = app(ManageClassWaitlist::class)->join($org, $this->studentWaitB, $this->classId, $this->offeringB, 'iso-wait-b')['entry_id'];

        // Released result on the branch-B seat: scorer/moderator/approver/
        // releaser stay independent.
        $results = app(ManageAssessmentResult::class);
        $attemptB = $results->submitAttempt($this->grantedActor('iso-scorer-b', ['academic.assess']), Enrollment::query()->findOrFail($this->seatB), 'assessment', 'scan/iso-b', 'iso-att-b');
        $resultB = $results->score($this->grantedActor('iso-scorer-b', ['academic.assess']), AssessmentAttempt::query()->findOrFail($attemptB['attempt_id']), '88.00', 'iso-score-b');
        $rowB = AssessmentResult::query()->findOrFail($resultB['result_id']);
        $results->moderate($this->grantedActor('iso-mod-b', ['academic.moderate']), $rowB, 'iso-mod-b');
        $results->approve($this->grantedActor('iso-appr-b', ['academic.approve_result']), $rowB, 'iso-appr-b');
        $results->release($this->grantedActor('iso-rel-b', ['academic.release']), $rowB, 'iso-rel-b');
        $this->releasedResultB = $rowB->id;

        // Moderated result on the branch-A seat for same-branch positives.
        $attemptA = $results->submitAttempt($this->grantedActor('iso-scorer-a', ['academic.assess']), Enrollment::query()->findOrFail($this->seatA), 'assessment', 'scan/iso-a', 'iso-att-a');
        $resultA = $results->score($this->grantedActor('iso-scorer-a', ['academic.assess']), AssessmentAttempt::query()->findOrFail($attemptA['attempt_id']), '81.00', 'iso-score-a');
        $rowA = AssessmentResult::query()->findOrFail($resultA['result_id']);
        $results->moderate($this->grantedActor('iso-mod-a', ['academic.moderate']), $rowA, 'iso-mod-a');
        $results->approve($this->grantedActor('iso-appr-a', ['academic.approve_result']), $rowA, 'iso-appr-a');
        $results->release($this->grantedActor('iso-rel-a', ['academic.release']), $rowA, 'iso-rel-a');
        $this->moderatedResultA = $rowA->id;
    }

    private function orgOfficer(): Actor
    {
        return $this->grantedActor('iso-org', self::CAPS);
    }

    private function branchOfficer(string $actorId, string $branchId): Actor
    {
        $this->personWithAuthority($actorId, []);
        $this->grantScopeAuthority($actorId, self::CAPS, 'branch', $branchId);

        return new Actor($actorId, 'Branch Officer');
    }

    private function newBranch(string $name): string
    {
        $id = Branch::query()->create([
            'id' => RandomIdentifier::new(),
            'name' => $name.' '.substr(md5(RandomIdentifier::new()), 0, 8),
            'lifecycle_state' => 'active',
        ])->id;
        $this->attachBranchToBootstrapOrganization($id);

        return $id;
    }

    private function newStudent(string $personId): string
    {
        $this->personWithAuthority($personId, []);
        $registered = app(RegisterApplicant::class)->register($this->admissionsClerk('iso-clerk-'.$personId), $personId, 'Program', 'iso-reg-'.$personId);
        $applicant = Applicant::query()->findOrFail($registered['applicant_id']);
        $this->runAdmissionDecision(
            $this->admissionsClerk('iso-clerk-'.$personId),
            $this->admissionsReviewer('iso-review-'.$personId),
            $this->admissionsApprover('iso-approve-'.$personId),
            $applicant,
            true,
            'meets policy',
            'ev/iso-'.$personId,
            'iso-adm-'.$personId,
        );

        return app(EnrollAdmittedApplicant::class)->convert($this->admissionsApprover('iso-approve-'.$personId), $applicant, 'iso-conv-'.$personId)['student_id'];
    }

    public function test_branch_officer_cannot_declare_availability_or_open_offerings_in_a_foreign_branch(): void
    {
        $officerA = $this->branchOfficer('iso-off-a-1', $this->branchA);

        try {
            app(MaintainAcademicStructure::class)->declareBranchAvailability($officerA, $this->branchB, $this->levelId, $this->periodId, 'iso-x-avail');
            $this->fail('a branch-A officer must not declare availability for branch B');
        } catch (AuthorizationDenied $denial) {
            $this->assertSame('academic.structure_denied', $denial->errorCode());
        }

        try {
            app(MaintainAcademicStructure::class)->openOffering($officerA, $this->branchB, $this->levelId, $this->periodId, 2, 'iso-x-off');
            $this->fail('a branch-A officer must not open an offering for branch B');
        } catch (AuthorizationDenied $denial) {
            $this->assertSame('academic.structure_denied', $denial->errorCode());
        }

        // Unknown branches fail closed instead of resolving to a null scope.
        try {
            app(MaintainAcademicStructure::class)->declareBranchAvailability($officerA, RandomIdentifier::new(), $this->levelId, $this->periodId, 'iso-x-unknown');
            $this->fail('an unknown branch must fail closed');
        } catch (BusinessRejection $rejection) {
            $this->assertSame('academic.branch_unknown', $rejection->errorCode());
        }

        // Positive control: the same officer declares availability at home.
        $avail = app(MaintainAcademicStructure::class)->declareBranchAvailability($officerA, $this->branchA, $this->level2Id, $this->periodId, 'iso-home-avail');
        $this->assertDatabaseHas('branch_availabilities', ['id' => $avail['availability_id'], 'branch_id' => $this->branchA]);
    }

    public function test_branch_officer_cannot_mutate_foreign_stored_offerings_and_rooms(): void
    {
        $officerA = $this->branchOfficer('iso-off-a-2', $this->branchA);
        $offerings = app(ManageAcademicOffering::class);

        foreach ([
            fn () => $offerings->closeAvailability($officerA, BranchAvailability::query()->findOrFail($this->availabilityB), 'iso-x-close-avail'),
            fn () => $offerings->closeOffering($officerA, Offering::query()->findOrFail($this->offeringB), 'iso-x-close-off'),
            fn () => $offerings->cancelOffering($officerA, Offering::query()->findOrFail($this->offeringB), 'iso-x-cancel-off'),
            fn () => $offerings->resizeCapacity($officerA, Offering::query()->findOrFail($this->offeringB), 9, 'iso-x-resize-off'),
        ] as $index => $attempt) {
            try {
                $attempt();
                $this->fail('foreign stored-record mutation #'.$index.' must be refused');
            } catch (AuthorizationDenied $denial) {
                $this->assertSame('academic.structure_denied', $denial->errorCode());
            }
        }

        $org = $this->orgOfficer();
        $roomB = app(MaintainRoom::class)->defineRoom($org, $this->branchB, 'Iso Room B', 'ISO-RB', 20, 'classroom', 'iso-room-b')['room_id'];
        $roomA = app(MaintainRoom::class)->defineRoom($org, $this->branchA, 'Iso Room A', 'ISO-RA', 20, 'classroom', 'iso-room-a')['room_id'];

        try {
            app(MaintainRoom::class)->defineRoom($officerA, $this->branchB, 'Iso Room X', 'ISO-RX', 10, 'classroom', 'iso-room-x');
            $this->fail('a branch-A officer must not define rooms for branch B');
        } catch (AuthorizationDenied $denial) {
            $this->assertSame('academic.structure_denied', $denial->errorCode());
        }
        try {
            app(MaintainRoom::class)->transition($officerA, AcademicRoom::query()->findOrFail($roomB), 'maintenance', 'iso-x-room-tr');
            $this->fail('a branch-A officer must not transition a branch-B room');
        } catch (AuthorizationDenied $denial) {
            $this->assertSame('academic.structure_denied', $denial->errorCode());
        }
        try {
            app(MaintainRoom::class)->resize($officerA, AcademicRoom::query()->findOrFail($roomB), 5, 'iso-x-room-rs');
            $this->fail('a branch-A officer must not resize a branch-B room');
        } catch (AuthorizationDenied $denial) {
            $this->assertSame('academic.structure_denied', $denial->errorCode());
        }

        // Positive control: the same officer resizes the home-branch room.
        app(MaintainRoom::class)->resize($officerA, AcademicRoom::query()->findOrFail($roomA), 25, 'iso-home-room-rs');
        $this->assertDatabaseHas('academic_rooms', ['id' => $roomA, 'capacity' => 25]);
    }

    public function test_enrollment_seat_verbs_are_branch_scoped(): void
    {
        $officerA = $this->branchOfficer('iso-off-a-3', $this->branchA);
        $enroll = app(MaintainEnrollment::class);

        try {
            $enroll->request($officerA, $this->studentFree, $this->classId, 'iso-x-enr', $this->offeringB);
            $this->fail('a branch-A officer must not request seats in a branch-B offering');
        } catch (AuthorizationDenied $denial) {
            $this->assertSame('academic.enrollment_denied', $denial->errorCode());
        }
        // A class-only seat inherits the student's home branch — the
        // activation gate follows it there.
        $branched = $this->newStudent('iso-activate-1');
        Student::query()->whereKey($branched)->update(['current_home_branch_id' => $this->branchB]);
        $requestedB = $enroll->request($this->orgOfficer(), $branched, $this->classId, 'iso-x-req-class-only')['enrollment_id'];
        $this->assertDatabaseHas('enrollments', ['id' => $requestedB, 'originating_branch_id' => $this->branchB]);
        try {
            $enroll->activate($officerA, Enrollment::query()->findOrFail($requestedB), 'iso-x-activate');
            $this->fail('a branch-A officer must not activate a branch-B seat');
        } catch (AuthorizationDenied $denial) {
            $this->assertSame('academic.enrollment_denied', $denial->errorCode());
        }
        try {
            $enroll->freeze($officerA, Enrollment::query()->findOrFail($this->seatB), 'probe', 'iso-x-freeze');
            $this->fail('a branch-A officer must not freeze a branch-B seat');
        } catch (AuthorizationDenied $denial) {
            $this->assertSame('academic.enrollment_denied', $denial->errorCode());
        }
        try {
            $enroll->withdraw($officerA, Enrollment::query()->findOrFail($this->seatB), 'probe', 'iso-x-withdraw');
            $this->fail('a branch-A officer must not withdraw a branch-B seat');
        } catch (AuthorizationDenied $denial) {
            $this->assertSame('academic.enrollment_denied', $denial->errorCode());
        }

        // A transfer into a foreign offering is refused even though the seat
        // itself is at home: both ends are enforced.
        try {
            $enroll->transfer($officerA, Enrollment::query()->findOrFail($this->seatA), $this->classId, 'iso-x-transfer', $this->offeringB);
            $this->fail('a branch-A officer must not transfer a seat into branch B');
        } catch (AuthorizationDenied $denial) {
            $this->assertSame('academic.enrollment_denied', $denial->errorCode());
        }

        // Positive controls: request and freeze at home.
        $home = $enroll->request($officerA, $this->studentFree, $this->classId, 'iso-home-enr', $this->offeringA);
        $enroll->activate($officerA, Enrollment::query()->findOrFail($home['enrollment_id']), 'iso-home-act');
        $this->assertDatabaseHas('enrollments', ['id' => $home['enrollment_id'], 'lifecycle_state' => 'active', 'originating_branch_id' => $this->branchA]);
    }

    public function test_waitlist_and_attendance_are_branch_scoped(): void
    {
        $officerA = $this->branchOfficer('iso-off-a-4', $this->branchA);

        try {
            app(ManageClassWaitlist::class)->join($officerA, $this->studentFree, $this->classId, $this->offeringB, 'iso-x-wait');
            $this->fail('a branch-A officer must not queue students on a branch-B offering');
        } catch (AuthorizationDenied $denial) {
            $this->assertSame('academic.waitlist_denied', $denial->errorCode());
        }
        try {
            app(ManageClassWaitlist::class)->promote($officerA, ClassWaitlistEntry::query()->findOrFail($this->waitB), 'iso-x-promote');
            $this->fail('a branch-A officer must not promote a branch-B queue entry');
        } catch (AuthorizationDenied $denial) {
            $this->assertSame('academic.waitlist_denied', $denial->errorCode());
        }
        try {
            app(RecordAttendance::class)->record($officerA, ClassSession::query()->findOrFail($this->sessionId), Enrollment::query()->findOrFail($this->seatB), 'present', 'iso-x-att');
            $this->fail('a branch-A officer must not record attendance on a branch-B seat');
        } catch (AuthorizationDenied $denial) {
            $this->assertSame('academic.attendance_denied', $denial->errorCode());
        }

        // Positive control: attendance on the home seat records.
        app(RecordAttendance::class)->record($officerA, ClassSession::query()->findOrFail($this->sessionId), Enrollment::query()->findOrFail($this->seatA), 'present', 'iso-home-att');
        $this->assertDatabaseHas('attendance_facts', ['enrollment_id' => $this->seatA, 'status' => 'present']);
    }

    public function test_assessment_verbs_are_branch_scoped(): void
    {
        $officerA = $this->branchOfficer('iso-off-a-5', $this->branchA);
        $results = app(ManageAssessmentResult::class);

        try {
            $results->submitAttempt($officerA, Enrollment::query()->findOrFail($this->seatB), 'assessment', 'scan/iso-x', 'iso-x-att2');
            $this->fail('a branch-A officer must not assess a branch-B seat');
        } catch (AuthorizationDenied $denial) {
            $this->assertSame('academic.assess_denied', $denial->errorCode());
        }
        try {
            $results->markAppealed($officerA, AssessmentResult::query()->findOrFail($this->releasedResultB), 'iso-x-mark');
            $this->fail('a branch-A officer must not mark a branch-B result appealed');
        } catch (AuthorizationDenied $denial) {
            $this->assertSame('academic.result_denied', $denial->errorCode());
        }
        try {
            $results->proposeCorrection($officerA, AssessmentResult::query()->findOrFail($this->releasedResultB), '89.00', 'probe', 'iso-x-cor');
            $this->fail('a branch-A officer must not correct a branch-B result');
        } catch (AuthorizationDenied $denial) {
            $this->assertSame('academic.moderate_denied', $denial->errorCode());
        }

        // Positive control: the home result can be marked appealed.
        $results->markAppealed($officerA, AssessmentResult::query()->findOrFail($this->moderatedResultA), 'iso-home-mark');
        $this->assertDatabaseHas('assessment_results', ['id' => $this->moderatedResultA, 'lifecycle_state' => 'appealed']);
    }

    public function test_student_anchored_verbs_follow_the_branched_student(): void
    {
        $officerA = $this->branchOfficer('iso-off-a-6', $this->branchA);

        try {
            app(DecideProgression::class)->propose($officerA, $this->studentB, $this->classId, 'advance', 'probe', 'iso-x-prog');
            $this->fail('a branch-A officer must not propose progression for a branch-B student');
        } catch (AuthorizationDenied $denial) {
            $this->assertSame('academic.progression_denied', $denial->errorCode());
        }
        try {
            app(DecideGraduation::class)->propose($officerA, $this->studentB, $this->programVersionId, 'eligible', 'probe basis', 'iso-x-grad');
            $this->fail('a branch-A officer must not propose graduation for a branch-B student');
        } catch (AuthorizationDenied $denial) {
            $this->assertSame('academic.graduation_denied', $denial->errorCode());
        }
        try {
            app(IssueTranscript::class)->issue($officerA, $this->studentB, $this->programVersionId, 'iso-x-tr');
            $this->fail('a branch-A officer must not issue transcripts for a branch-B student');
        } catch (AuthorizationDenied $denial) {
            $this->assertSame('academic.transcript_denied', $denial->errorCode());
        }

        // Positive control: the branch-B officer proposes progression there.
        $officerB = $this->branchOfficer('iso-off-b-6', $this->branchB);
        $decision = app(DecideProgression::class)->propose($officerB, $this->studentB, $this->classId, 'advance', 'meets the boundary rules', 'iso-home-prog', $this->releasedResultB, 'released result review confirms readiness');
        $this->assertDatabaseHas('progression_decisions', ['id' => $decision['decision_id'], 'student_id' => $this->studentB]);
    }

    public function test_appeal_lifecycle_is_branch_scoped(): void
    {
        $appeals = app(ManageAcademicAppeal::class);
        $org = $this->orgOfficer();
        $officerA = $this->branchOfficer('iso-off-a-7', $this->branchA);

        try {
            $appeals->file($officerA, $this->studentB, 'assessment_result', $this->releasedResultB, 'probe', 'iso-x-file');
            $this->fail('a branch-A officer must not file appeals on branch-B subjects');
        } catch (AuthorizationDenied $denial) {
            $this->assertSame('academic.appeal_denied', $denial->errorCode());
        }

        $appeal = $appeals->file($org, $this->studentB, 'assessment_result', $this->releasedResultB, 'section two was mis-marked', 'iso-file-b');
        $this->branchOfficer('iso-reviewer-b-7', $this->branchB);
        $appeals->assign($org, AcademicAppeal::query()->findOrFail($appeal['appeal_id']), 'iso-reviewer-b-7', 'iso-assign-b');

        $openAppeal = $appeals->file($org, $this->studentB, 'assessment_result', $this->releasedResultB, 'second reading requested', 'iso-file-b2');
        try {
            $appeals->assign($officerA, AcademicAppeal::query()->findOrFail($openAppeal['appeal_id']), 'iso-off-a-7', 'iso-x-assign');
            $this->fail('a branch-A officer must not reassign a branch-B appeal');
        } catch (AuthorizationDenied $denial) {
            $this->assertSame('academic.appeal_denied', $denial->errorCode());
        }

        // Positive control: the branch-B officer files on a branch-B subject.
        $officerB = $this->branchOfficer('iso-off-b-7', $this->branchB);
        $home = $appeals->file($officerB, $this->studentB, 'assessment_result', $this->releasedResultB, 'home-branch filing', 'iso-home-file');
        $this->assertDatabaseHas('academic_appeals', ['id' => $home['appeal_id'], 'student_id' => $this->studentB]);
    }

    public function test_org_wide_authority_still_covers_every_branch(): void
    {
        $org = $this->orgOfficer();

        // Non-destructive sweep across layers on branch-B records.
        app(ManageAcademicOffering::class)->resizeCapacity($org, Offering::query()->findOrFail($this->offeringB), 6, 'iso-org-resize');
        app(MaintainEnrollment::class)->freeze($org, Enrollment::query()->findOrFail($this->seatB), 'org hold', 'iso-org-freeze');
        app(MaintainEnrollment::class)->unfreeze($org, Enrollment::query()->findOrFail($this->seatB), 'iso-org-unfreeze');
        app(RecordAttendance::class)->record($org, ClassSession::query()->findOrFail($this->sessionId), Enrollment::query()->findOrFail($this->seatB), 'present', 'iso-org-att');

        $this->assertDatabaseHas('offerings', ['id' => $this->offeringB, 'capacity' => 6]);
        $this->assertDatabaseHas('enrollments', ['id' => $this->seatB, 'lifecycle_state' => 'active']);
        $this->assertDatabaseHas('attendance_facts', ['enrollment_id' => $this->seatB, 'status' => 'present']);
    }

    public function test_governance_verbs_stay_capability_gated_by_design(): void
    {
        // Governance rows are branchless: the single access authority gates
        // them on capability alone, so a branch-narrow grant still performs
        // global governance. This locks the ratified semantic in place: it
        // exposes no foreign-branch record, and changing it belongs to the
        // Access authority — not to Academic branch scoping.
        $officerA = $this->branchOfficer('iso-off-a-9', $this->branchA);
        $period = app(MaintainAcademicStructure::class)->definePeriod(
            $officerA, 'Isolation Governance Term', new CarbonImmutable('2027-01-01'), new CarbonImmutable('2027-03-30'), 'iso-gov-period'
        );
        $this->assertDatabaseHas('academic_periods', ['id' => $period['period_id']]);
    }
}
