<?php

declare(strict_types=1);

namespace Tests\Feature\Academic;

use App\Modules\Academic\Commands\MaintainAcademicStructure;
use App\Modules\Academic\Commands\MaintainClass;
use App\Modules\Academic\Commands\MaintainEnrollment;
use App\Modules\Academic\Commands\ManageAcademicOffering;
use App\Modules\Academic\Commands\ManageClassWaitlist;
use App\Modules\Academic\Models\AcademicPeriod;
use App\Modules\Academic\Models\BranchAvailability;
use App\Modules\Academic\Models\ClassModel;
use App\Modules\Academic\Models\ClassWaitlistEntry;
use App\Modules\Academic\Models\Enrollment;
use App\Modules\Academic\Models\Offering;
use App\Modules\Academic\Models\Program;
use App\Modules\Academic\Queries\ClassWaitlistQuery;
use App\Modules\Academic\Queries\OfferingCatalogQuery;
use App\Modules\Admissions\Commands\EnrollAdmittedApplicant;
use App\Modules\Admissions\Commands\RegisterApplicant;
use App\Modules\Admissions\Models\Applicant;
use App\Modules\Organization\Models\Branch;
use App\Support\Errors\BusinessRejection;
use App\Support\Identifiers\RandomIdentifier;
use Carbon\CarbonImmutable;
use Tests\Concerns\BuildsActors;
use Tests\Concerns\DecidesAdmissions;
use Tests\TestCase;

final class AcademicOfferingAndWaitlistFeatureTest extends TestCase
{
    use BuildsActors;
    use DecidesAdmissions;

    private string $branchId;

    private string $levelId;

    private string $periodId;

    private string $programVersionId;

    private string $offeringId;

    private string $classId;

    private string $teacherPersonId = 'offering-teacher-1';

    protected function setUp(): void
    {
        parent::setUp();
        $this->personWithAuthority($this->teacherPersonId, []);
        $structure = app(MaintainAcademicStructure::class);
        $officer = $this->academicOfficer('offering-officer-setup');

        $this->branchId = Branch::query()->create([
            'id' => RandomIdentifier::new(),
            'name' => 'Offering Branch '.substr(md5(RandomIdentifier::new()), 0, 8),
            'lifecycle_state' => 'active',
        ])->id;
        $this->attachBranchToBootstrapOrganization($this->branchId);

        $program = $structure->defineProgram($officer, 'Offering Intensive', 'off-prog');
        $version = $structure->publishVersion($officer, Program::query()->findOrFail($program['program_id']), 'Offering v1', 'off-ver');
        $this->programVersionId = $version['version_id'];
        $this->levelId = $structure->defineLevel($officer, $this->programVersionId, 'starter', 1, 'Starter', 'A1', 'off-lvl')['level_id'];

        $this->periodId = $structure->definePeriod($officer, 'Offering Term', new CarbonImmutable('2026-10-01'), new CarbonImmutable('2026-12-30'), 'off-period')['period_id'];
        $structure->transitionPeriod($officer, AcademicPeriod::query()->findOrFail($this->periodId), 'published', 'off-period-pub');

        $availability = $structure->declareBranchAvailability($officer, $this->branchId, $this->levelId, $this->periodId, 'off-avail');
        $this->assertDatabaseHas('branch_availabilities', ['id' => $availability['availability_id'], 'lifecycle_state' => 'active']);

        $offering = $structure->openOffering($officer, $this->branchId, $this->levelId, $this->periodId, 1, 'off-offering');
        $this->offeringId = $offering['offering_id'];

        $this->classId = app(MaintainClass::class)->defineClass(
            $officer,
            $this->programVersionId,
            $this->periodId,
            2,
            'off-class',
            $this->levelId,
        )['class_id'];
        app(MaintainClass::class)->assignTeacher($officer, ClassModel::query()->findOrFail($this->classId), $this->teacherPersonId, new CarbonImmutable('2026-09-01'), null, 'off-class-teacher');
        app(MaintainClass::class)->transition($officer, ClassModel::query()->findOrFail($this->classId), 'published', 'off-class-pub');
        app(MaintainClass::class)->transition($officer, ClassModel::query()->findOrFail($this->classId), 'active', 'off-class-active');
    }

    private function newStudent(string $personId): string
    {
        $this->personWithAuthority($personId, []);
        $registered = app(RegisterApplicant::class)->register($this->admissionsClerk('off-clerk-'.$personId), $personId, 'Program', 'off-reg-'.$personId);
        /** @var Applicant $applicant */
        $applicant = Applicant::query()->findOrFail($registered['applicant_id']);
        $this->runAdmissionDecision(
            $this->admissionsClerk('off-clerk-'.$personId),
            $this->admissionsReviewer('off-review-'.$personId),
            $this->admissionsApprover('off-approve-'.$personId),
            $applicant, true, 'meets policy', 'ev/off', 'off-dec-'.$personId,
        );

        return app(EnrollAdmittedApplicant::class)->convert($this->admissionsApprover('off-approve-'.$personId), $applicant, 'off-conv-'.$personId)['student_id'];
    }

    public function test_offering_lifecycle_close_reopen_resize_and_complete(): void
    {
        $structure = app(MaintainAcademicStructure::class);
        $manager = app(ManageAcademicOffering::class);
        $officer = $this->academicOfficer('offering-officer-life');

        $this->assertSame(1, (new OfferingCatalogQuery)->catalogue($this->branchId, $this->periodId)['availabilities'][0]['offerings'][0]['capacity']);

        $resized = $manager->resizeCapacity($officer, Offering::query()->findOrFail($this->offeringId), 2, 'off-resize-1');
        $this->assertSame(2, $resized['capacity']);

        $closed = $manager->closeOffering($officer, Offering::query()->findOrFail($this->offeringId), 'off-close-1');
        $this->assertSame('closed', $closed['lifecycle_state']);

        $reopened = $manager->reopenOffering($officer, Offering::query()->findOrFail($this->offeringId), 'off-reopen-1');
        $this->assertSame('open', $reopened['lifecycle_state']);

        $completed = $manager->completeOffering($officer, Offering::query()->findOrFail($this->offeringId), 'off-complete-1');
        $this->assertSame('completed', $completed['lifecycle_state']);

        try {
            $manager->reopenOffering($officer, Offering::query()->findOrFail($this->offeringId), 'off-reopen-2');
            $this->fail('a completed offering cannot be reopened');
        } catch (BusinessRejection $rejection) {
            $this->assertSame('academic.offering_transition_forbidden', $rejection->errorCode());
        }

        $this->assertDatabaseHas('audit_events', ['operation' => 'academic.offering.resize']);
        $this->assertDatabaseHas('audit_events', ['operation' => 'academic.offering.transition.completed']);
    }

    public function test_availability_requires_no_open_offering_to_close_and_reopens(): void
    {
        $manager = app(ManageAcademicOffering::class);
        $officer = $this->academicOfficer('offering-officer-avail');

        try {
            $manager->closeAvailability($officer, BranchAvailability::query()->firstOrFail(), 'avail-close-1');
            $this->fail('availability cannot close while its offering is open');
        } catch (BusinessRejection $rejection) {
            $this->assertSame('academic.availability_open_offerings', $rejection->errorCode());
        }

        $manager->closeOffering($officer, Offering::query()->findOrFail($this->offeringId), 'off-close-2');
        $closedAvail = $manager->closeAvailability($officer, BranchAvailability::query()->firstOrFail(), 'avail-close-2');
        $this->assertSame('closed', $closedAvail['lifecycle_state']);

        $reopenedAvail = $manager->reopenAvailability($officer, BranchAvailability::query()->firstOrFail(), 'avail-reopen-1');
        $this->assertSame('active', $reopenedAvail['lifecycle_state']);

        $reopenedOffering = $manager->reopenOffering($officer, Offering::query()->findOrFail($this->offeringId), 'off-reopen-3');
        $this->assertSame('open', $reopenedOffering['lifecycle_state']);
    }

    public function test_enrollment_targets_only_an_open_matching_offering_and_counts_against_offering_capacity(): void
    {
        $structure = app(MaintainAcademicStructure::class);
        $officer = $this->academicOfficer('offering-officer-enroll');
        $clerk = $this->enrollmentClerk('offering-clerk-enroll');
        $studentA = $this->newStudent('offering-student-a');
        $studentB = $this->newStudent('offering-student-b');

        $seatA = app(MaintainEnrollment::class)->request($clerk, $studentA, $this->classId, 'off-enr-1', $this->offeringId);
        app(MaintainEnrollment::class)->activate($officer, Enrollment::query()->findOrFail($seatA['enrollment_id']), 'off-enr-2');

        $seatB = app(MaintainEnrollment::class)->request($clerk, $studentB, $this->classId, 'off-enr-3', $this->offeringId);
        try {
            app(MaintainEnrollment::class)->activate($officer, Enrollment::query()->findOrFail($seatB['enrollment_id']), 'off-enr-4');
            $this->fail('offering capacity must limit activation even with class room');
        } catch (BusinessRejection $rejection) {
            $this->assertSame('academic.offering_full', $rejection->errorCode());
        }

        // Close first, then attempt a new request against the closed offering.
        app(ManageAcademicOffering::class)->closeOffering($officer, Offering::query()->findOrFail($this->offeringId), 'off-close-3');
        $studentC = $this->newStudent('offering-student-c');
        try {
            app(MaintainEnrollment::class)->request($clerk, $studentC, $this->classId, 'off-enr-5', $this->offeringId);
            $this->fail('a closed offering must not accept a new enrollment request');
        } catch (BusinessRejection $rejection) {
            $this->assertSame('academic.offering_not_open', $rejection->errorCode());
        }

        // Enrollments carry the immutable offering link.
        $this->assertSame($this->offeringId, trim((string) Enrollment::query()->findOrFail($seatA['enrollment_id'])->offering_id));
        $this->assertSame($this->offeringId, trim((string) Enrollment::query()->findOrFail($seatB['enrollment_id'])->offering_id));
    }

    public function test_waitlist_join_offer_promote_and_withdraw(): void
    {
        $officer = $this->academicOfficer('waitlist-officer-1');
        $clerk = $this->enrollmentClerk('waitlist-clerk-1');
        $waitlist = app(ManageClassWaitlist::class);
        $studentA = $this->newStudent('waitlist-student-a');
        $studentB = $this->newStudent('waitlist-student-b');

        // First seat fills the only class/offering seat.
        $seatA = app(MaintainEnrollment::class)->request($clerk, $studentA, $this->classId, 'wl-enr-1', $this->offeringId);
        app(MaintainEnrollment::class)->activate($officer, Enrollment::query()->findOrFail($seatA['enrollment_id']), 'wl-enr-2');

        $joined = $waitlist->join($clerk, $studentB, $this->classId, $this->offeringId, 'wl-join-1');
        $this->assertSame(1, $joined['position']);

        // No offering capacity yet, so an offer is refused.
        try {
            $waitlist->offer($officer, ClassWaitlistEntry::query()->findOrFail($joined['entry_id']), 'wl-offer-1');
            $this->fail('an offer must require a free seat');
        } catch (BusinessRejection $rejection) {
            $this->assertSame('academic.waitlist_offering_full', $rejection->errorCode());
        }

        // Freeing the seat lets the offer and promote flow complete.
        app(MaintainEnrollment::class)->withdraw($clerk, Enrollment::query()->findOrFail($seatA['enrollment_id']), 'student left the branch', 'wl-withdraw-a');
        $waitlist->offer($officer, ClassWaitlistEntry::query()->findOrFail($joined['entry_id']), 'wl-offer-2');

        $approver = $this->grantedActor('waitlist-approve-1', ['academic.enroll', 'academic.enroll_approve']);
        $promoted = $waitlist->promote($approver, ClassWaitlistEntry::query()->findOrFail($joined['entry_id']), 'wl-promote-1');
        $this->assertDatabaseHas('class_waitlist_entries', ['id' => $joined['entry_id'], 'lifecycle_state' => 'enrolled']);
        $this->assertDatabaseHas('enrollments', ['id' => $promoted['enrollment_id'], 'class_id' => $this->classId, 'offering_id' => $this->offeringId, 'lifecycle_state' => 'requested']);

        // Once the promoted seat is activated the offering is full again, so a
        // second student can join and then withdraw cleanly.
        app(MaintainEnrollment::class)->activate($approver, Enrollment::query()->findOrFail($promoted['enrollment_id']), 'wl-activate-1');
        $studentC = $this->newStudent('waitlist-student-c');
        $joinedC = $waitlist->join($clerk, $studentC, $this->classId, $this->offeringId, 'wl-join-2');
        $this->assertSame(1, $joinedC['position']);

        $queue = (new ClassWaitlistQuery)->forClass($this->classId);
        $this->assertCount(1, $queue['waitlist']);

        $withdrawn = $waitlist->withdraw($clerk, ClassWaitlistEntry::query()->findOrFail($joinedC['entry_id']), 'wl-withdraw-c');
        $this->assertSame('withdrawn', $withdrawn['lifecycle_state']);
        $this->assertCount(0, (new ClassWaitlistQuery)->forClass($this->classId)['waitlist']);

        $this->assertDatabaseHas('audit_events', ['operation' => 'academic.waitlist.promote']);
    }
}
