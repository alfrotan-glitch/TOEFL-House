<?php

declare(strict_types=1);

namespace Tests\Feature\Academic;

use App\Modules\Academic\Commands\MaintainAcademicStructure;
use App\Modules\Academic\Domain\ClassLifecycle;
use App\Modules\Academic\Models\AcademicPeriod;
use App\Modules\Academic\Models\ClassModel;
use App\Modules\Academic\Models\Program;
use App\Modules\Academic\Models\TeacherAssignment;
use App\Modules\Identity\Models\Person;
use App\Modules\Identity\Models\UserAccount;
use App\Support\Identifiers\RandomIdentifier;
use Carbon\CarbonImmutable;
use Illuminate\Support\Facades\Hash;
use Tests\Concerns\BuildsActors;
use Tests\TestCase;

/**
 * Regression coverage for two E2E business-journey dead ends that only appear
 * over real HTTP (the in-process command tests drive the commands directly
 * and never noticed the transport never exposed them):
 *
 *   1. Person intake — no route/command created the unverified person record
 *      Admissions/HR start from, so a fresh system could never register its
 *      first applicant.
 *   2. Class delivery — MaintainClass::defineClass / transition / assignTeacher
 *      had no HTTP surface, so a class could never be opened (active classes
 *      require an open teacher assignment), blocking enrollment activation and
 *      therefore placement assessment.
 */
final class ClassAndIntakeTransportFeatureTest extends TestCase
{
    use BuildsActors;

    private function signInAs(string $personId, string $username): void
    {
        UserAccount::query()->create([
            'id' => RandomIdentifier::new(),
            'person_id' => $personId,
            'username' => $username,
            'password_hash' => Hash::make('transport-pw-1'),
            'account_state' => UserAccount::STATE_ACTIVE,
        ]);
        $this->post('/login', ['username' => $username, 'password' => 'transport-pw-1'])->assertRedirect('/');
    }

    public function test_person_intake_creates_an_unverified_person_over_http(): void
    {
        $admin = $this->personWithAuthority('intake-admin', ['identity.admin']);
        $this->signInAs($admin->id, 'intake.admin');

        $this->postJson('/api/identity/people', [
            'legal_name' => 'New Prospect',
            'date_of_birth' => '2005-06-15',
        ])->assertCreated()->assertJsonPath('status', 'registered');

        $person = Person::query()->where('legal_name', 'New Prospect')->firstOrFail();
        $this->assertSame(Person::VERIFICATION_UNVERIFIED, $person->verification_state);
        $this->assertNull($person->identity_key);
    }

    public function test_person_intake_requires_identity_admin(): void
    {
        $nobody = $this->personWithAuthority('intake-nobody', []);
        $this->signInAs($nobody->id, 'intake.nobody');

        $this->postJson('/api/identity/people', [
            'legal_name' => 'Blocked Prospect',
            'date_of_birth' => '2005-06-15',
        ])->assertForbidden();

        $this->assertDatabaseMissing('people', ['legal_name' => 'Blocked Prospect']);
    }

    public function test_a_class_can_be_defined_staffed_and_activated_over_http(): void
    {
        $officer = $this->personWithAuthority('class-officer', ['academic.structure', 'academic.schedule']);
        $this->signInAs($officer->id, 'class.officer');

        // Program + published version + published period (structure commands
        // are already exposed; the class was not).
        $program = app(MaintainAcademicStructure::class)
            ->defineProgram($this->grantedActor($officer->id, []), 'TOEFL Intensive', 'k-prog-'.RandomIdentifier::new());
        $version = app(MaintainAcademicStructure::class)
            ->publishVersion($this->grantedActor($officer->id, []), Program::findOrFail($program['program_id']), 'v1', 'k-ver-'.RandomIdentifier::new());
        $period = app(MaintainAcademicStructure::class)
            ->definePeriod($this->grantedActor($officer->id, []), 'Fall 2026', new CarbonImmutable('2026-09-01'), new CarbonImmutable('2026-12-18'), 'k-per-'.RandomIdentifier::new());
        app(MaintainAcademicStructure::class)
            ->transitionPeriod($this->grantedActor($officer->id, []), AcademicPeriod::findOrFail($period['period_id']), 'published', 'k-per-pub-'.RandomIdentifier::new());

        // 1. Define a class over HTTP (previously no route existed).
        $this->post('/academic/classes', [
            'program_version_id' => $version['version_id'],
            'period_id' => $period['period_id'],
            'capacity' => 10,
        ])->assertRedirect();
        $class = ClassModel::query()->where('program_version_id', $version['version_id'])->firstOrFail();
        $this->assertSame(ClassLifecycle::STATE_PLANNED, $class->lifecycle_state);

        // 2. Assign a teacher over HTTP (previously no route existed) — a class
        //    needs an open teacher assignment to become active.
        $teacher = $this->personWithAuthority('class-teacher', []);
        $this->post('/academic/teacher-assignments', [
            'class_id' => $class->id,
            'teacher_person_id' => $teacher->id,
            'effective_from' => '2026-09-01',
        ])->assertRedirect();
        $this->assertTrue(TeacherAssignment::query()->where('class_id', $class->id)->whereNull('effective_to')->exists());

        // 3. planned -> published -> active over HTTP.
        $this->post("/academic/classes/{$class->id}/transition", ['to_state' => 'published'])->assertRedirect();
        $this->post("/academic/classes/{$class->id}/transition", ['to_state' => 'active'])->assertRedirect();
        $this->assertSame(ClassLifecycle::STATE_ACTIVE, $class->refresh()->lifecycle_state);
    }

    public function test_a_class_cannot_be_activated_without_a_teacher_over_http(): void
    {
        $officer = $this->personWithAuthority('class-officer-2', ['academic.structure', 'academic.schedule']);
        $this->signInAs($officer->id, 'class.officer2');

        $program = app(MaintainAcademicStructure::class)
            ->defineProgram($this->grantedActor($officer->id, []), 'TOEFL Sprint', 'k2-prog-'.RandomIdentifier::new());
        $version = app(MaintainAcademicStructure::class)
            ->publishVersion($this->grantedActor($officer->id, []), Program::findOrFail($program['program_id']), 'v1', 'k2-ver-'.RandomIdentifier::new());
        $period = app(MaintainAcademicStructure::class)
            ->definePeriod($this->grantedActor($officer->id, []), 'Spring 2027', new CarbonImmutable('2027-01-05'), new CarbonImmutable('2027-04-30'), 'k2-per-'.RandomIdentifier::new());
        app(MaintainAcademicStructure::class)
            ->transitionPeriod($this->grantedActor($officer->id, []), AcademicPeriod::findOrFail($period['period_id']), 'published', 'k2-per-pub-'.RandomIdentifier::new());

        $this->post('/academic/classes', [
            'program_version_id' => $version['version_id'],
            'period_id' => $period['period_id'],
            'capacity' => 5,
        ])->assertRedirect();
        $class = ClassModel::query()->where('program_version_id', $version['version_id'])->firstOrFail();

        $this->post("/academic/classes/{$class->id}/transition", ['to_state' => 'published'])->assertRedirect();
        // No teacher assigned -> activation must be rejected (mapped 409), never 500.
        $this->post("/academic/classes/{$class->id}/transition", ['to_state' => 'active'])
            ->assertSessionHas('error_code', 'academic.class_needs_teacher');
        $this->assertSame(ClassLifecycle::STATE_PUBLISHED, $class->refresh()->lifecycle_state);
    }
}
