<?php

declare(strict_types=1);

namespace Tests\Feature\Console;

use App\Modules\Academic\Commands\MaintainAcademicStructure;
use App\Modules\Academic\Commands\MaintainClass;
use App\Modules\Academic\Models\AcademicPeriod;
use App\Modules\Academic\Models\BranchAvailability;
use App\Modules\Academic\Models\ClassModel;
use App\Modules\Academic\Models\Offering;
use App\Modules\Academic\Models\Program;
use App\Modules\Admissions\Commands\EnrollAdmittedApplicant;
use App\Modules\Admissions\Commands\RegisterApplicant;
use App\Modules\Admissions\Models\Applicant;
use App\Modules\Identity\Models\UserAccount;
use App\Modules\Organization\Models\Branch;
use App\Support\Identifiers\RandomIdentifier;
use Carbon\CarbonImmutable;
use Illuminate\Support\Facades\Hash;
use Tests\Concerns\BuildsActors;
use Tests\Concerns\DecidesAdmissions;
use Tests\TestCase;

/**
 * AC8: the certified branch-availability and offering lifecycle is
 * operational through the employee console. Availability declaration,
 * opening, closing, reopening, cancelling, completing, and resizing
 * offerings, and offering selection on seat requests are exercised over
 * the real HTTP surface; domain guards refuse unsafe transitions with
 * the governed error shape instead of a state change.
 */
final class OfferingOperationsConsoleTest extends TestCase
{
    use BuildsActors;
    use DecidesAdmissions;

    private string $branchId;

    private string $levelId;

    private string $secondLevelId;

    private string $periodId;

    private string $programVersionId;

    protected function setUp(): void
    {
        parent::setUp();

        $officer = $this->academicOfficer('offering-console-setup');
        $structure = app(MaintainAcademicStructure::class);

        $this->branchId = Branch::query()->create([
            'id' => RandomIdentifier::new(),
            'name' => 'Console Branch '.substr(md5(RandomIdentifier::new()), 0, 8),
            'lifecycle_state' => 'active',
        ])->id;
        $this->attachBranchToBootstrapOrganization($this->branchId);

        $program = $structure->defineProgram($officer, 'Console Intensive', 'con-prog');
        $version = $structure->publishVersion($officer, Program::query()->findOrFail($program['program_id']), 'Console v1', 'con-ver');
        $this->programVersionId = $version['version_id'];
        $this->levelId = $structure->defineLevel($officer, $this->programVersionId, 'starter', 1, 'Starter', 'A1', 'con-lvl')['level_id'];
        $this->secondLevelId = $structure->defineLevel($officer, $this->programVersionId, 'elementary', 2, 'Elementary', 'A2', 'con-lvl-2')['level_id'];

        $this->periodId = $structure->definePeriod($officer, 'Console Term', new CarbonImmutable('2026-10-01'), new CarbonImmutable('2026-12-30'), 'con-period')['period_id'];
        $structure->transitionPeriod($officer, AcademicPeriod::query()->findOrFail($this->periodId), 'published', 'con-period-pub');

        $this->makeEmployee('con-officer-1', ['academic.structure'], 'structure-officer');
        $this->makeEmployee('con-clerk-1', ['academic.enroll'], 'enrollment-clerk');
    }

    private function makeEmployee(string $personId, array $capabilities, string $username): void
    {
        $person = $this->personWithAuthority($personId, $capabilities);
        UserAccount::query()->create([
            'id' => RandomIdentifier::new(),
            'person_id' => $person->id,
            'username' => $username,
            'password_hash' => Hash::make('con-password-1'),
            'account_state' => UserAccount::STATE_ACTIVE,
        ]);
    }

    private function signIn(string $username): void
    {
        $this->post('/login', ['username' => $username, 'password' => 'con-password-1'])->assertRedirect('/');
        $this->assertAuthenticated();
    }

    private function signOut(): void
    {
        $this->post('/logout')->assertRedirect('/login');
        $this->assertGuest();
    }

    /** @return array{availability_id: string} */
    private function declareAvailabilityViaConsole(?string $levelId = null): array
    {
        $levelId ??= $this->levelId;
        $this->post('/academic/availabilities', [
            'branch_id' => $this->branchId,
            'program_version_level_id' => $levelId,
            'academic_period_id' => $this->periodId,
        ])->assertRedirect('/academic');

        /** @var BranchAvailability $availability */
        $availability = BranchAvailability::query()->where('branch_id', $this->branchId)->where('program_version_level_id', $levelId)->firstOrFail();
        $this->assertDatabaseHas('branch_availabilities', ['id' => $availability->id, 'lifecycle_state' => 'active']);

        return ['availability_id' => $availability->id];
    }

    private function openOfferingViaConsole(int $capacity = 4, ?string $levelId = null): string
    {
        $levelId ??= $this->levelId;
        $this->post('/academic/offerings', [
            'branch_id' => $this->branchId,
            'program_version_level_id' => $levelId,
            'academic_period_id' => $this->periodId,
            'capacity' => $capacity,
        ])->assertRedirect('/academic');

        /** @var Offering $offering */
        $offering = Offering::query()->where('branch_id', $this->branchId)->where('program_version_level_id', $levelId)->latest('id')->firstOrFail();
        $this->assertDatabaseHas('offerings', ['id' => $offering->id, 'lifecycle_state' => 'open', 'capacity' => $capacity]);

        return $offering->id;
    }

    public function test_availability_declare_close_reopen_through_console(): void
    {
        $this->signIn('structure-officer');

        $this->get('/academic')->assertOk()->assertSee('Branch availability');

        $availabilityId = $this->declareAvailabilityViaConsole()['availability_id'];

        $this->post("/academic/availabilities/{$availabilityId}/close")->assertRedirect('/academic');
        $this->assertDatabaseHas('branch_availabilities', ['id' => $availabilityId, 'lifecycle_state' => 'closed']);

        $this->post("/academic/availabilities/{$availabilityId}/reopen")->assertRedirect('/academic');
        $this->assertDatabaseHas('branch_availabilities', ['id' => $availabilityId, 'lifecycle_state' => 'active']);
    }

    public function test_offering_open_resize_close_reopen_complete_and_cancel_through_console(): void
    {
        $this->signIn('structure-officer');
        $this->declareAvailabilityViaConsole();

        $offeringId = $this->openOfferingViaConsole(4);

        $this->post("/academic/offerings/{$offeringId}/resize", ['capacity' => 6])->assertRedirect('/academic');
        $this->assertDatabaseHas('offerings', ['id' => $offeringId, 'capacity' => 6]);

        $this->post("/academic/offerings/{$offeringId}/close")->assertRedirect('/academic');
        $this->assertDatabaseHas('offerings', ['id' => $offeringId, 'lifecycle_state' => 'closed']);

        $this->post("/academic/offerings/{$offeringId}/reopen")->assertRedirect('/academic');
        $this->assertDatabaseHas('offerings', ['id' => $offeringId, 'lifecycle_state' => 'open']);

        $this->post("/academic/offerings/{$offeringId}/complete")->assertRedirect('/academic');
        $this->assertDatabaseHas('offerings', ['id' => $offeringId, 'lifecycle_state' => 'completed']);

        $this->declareAvailabilityViaConsole($this->secondLevelId);
        $cancelledId = $this->openOfferingViaConsole(2, $this->secondLevelId);
        $this->post("/academic/offerings/{$cancelledId}/cancel")->assertRedirect('/academic');
        $this->assertDatabaseHas('offerings', ['id' => $cancelledId, 'lifecycle_state' => 'cancelled']);
    }

    public function test_availability_close_refused_while_offering_open(): void
    {
        $this->signIn('structure-officer');
        $availabilityId = $this->declareAvailabilityViaConsole()['availability_id'];
        $this->openOfferingViaConsole(4);

        $this->post("/academic/availabilities/{$availabilityId}/close")
            ->assertRedirect('/')
            ->assertSessionHas('error_code');

        $this->assertDatabaseHas('branch_availabilities', ['id' => $availabilityId, 'lifecycle_state' => 'active']);
    }

    public function test_seat_request_targets_open_offering_through_console(): void
    {
        $this->signIn('structure-officer');
        $this->declareAvailabilityViaConsole();
        $offeringId = $this->openOfferingViaConsole(4);
        $this->signOut();

        $officer = $this->academicOfficer('offering-console-teach');
        $this->personWithAuthority('con-teacher-1', []);
        $classId = app(MaintainClass::class)->defineClass(
            $officer, $this->programVersionId, $this->periodId, 4, 'con-class', $this->levelId,
        )['class_id'];
        app(MaintainClass::class)->assignTeacher($officer, ClassModel::query()->findOrFail($classId), 'con-teacher-1', new CarbonImmutable('2026-09-01'), null, 'con-class-teacher');
        app(MaintainClass::class)->transition($officer, ClassModel::query()->findOrFail($classId), 'published', 'con-class-pub');
        app(MaintainClass::class)->transition($officer, ClassModel::query()->findOrFail($classId), 'active', 'con-class-act');

        $studentId = $this->newStudent('con-stu-1');

        $this->signIn('enrollment-clerk');
        $this->post('/academic/enrollments', [
            'student_id' => $studentId,
            'class_id' => $classId,
            'offering_id' => $offeringId,
        ])->assertRedirect('/academic');

        $this->assertDatabaseHas('enrollments', [
            'student_id' => $studentId,
            'class_id' => $classId,
            'offering_id' => $offeringId,
            'lifecycle_state' => 'requested',
        ]);

        // A closed offering can no longer take seats: the governed rejection
        // surfaces without a state change.
        $this->signOut();
        $this->signIn('structure-officer');
        $this->post("/academic/offerings/{$offeringId}/close")->assertRedirect('/academic');
        $this->signOut();

        $secondStudentId = $this->newStudent('con-stu-2');
        $this->signIn('enrollment-clerk');
        $this->post('/academic/enrollments', [
            'student_id' => $secondStudentId,
            'class_id' => $classId,
            'offering_id' => $offeringId,
        ])->assertRedirect('/')->assertSessionHas('error_code');

        $this->assertDatabaseMissing('enrollments', ['student_id' => $secondStudentId, 'class_id' => $classId]);
    }

    private function newStudent(string $personId): string
    {
        $this->personWithAuthority($personId, []);
        $registered = app(RegisterApplicant::class)->register($this->admissionsClerk('con-clerk-'.$personId), $personId, 'Program', 'con-reg-'.$personId);
        /** @var Applicant $applicant */
        $applicant = Applicant::query()->findOrFail($registered['applicant_id']);
        $this->runAdmissionDecision(
            $this->admissionsClerk('con-clerk-'.$personId),
            $this->admissionsReviewer('con-review-'.$personId),
            $this->admissionsApprover('con-approve-'.$personId),
            $applicant, true, 'meets policy', 'ev/con', 'con-dec-'.$personId,
        );

        return app(EnrollAdmittedApplicant::class)->convert($this->admissionsApprover('con-approve-'.$personId), $applicant, 'con-conv-'.$personId)['student_id'];
    }
}
