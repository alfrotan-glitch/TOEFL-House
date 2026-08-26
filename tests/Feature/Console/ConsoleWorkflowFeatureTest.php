<?php

declare(strict_types=1);

namespace Tests\Feature\Console;

use App\Modules\Admissions\Models\Applicant;
use App\Modules\Identity\Models\Person;
use App\Modules\Identity\Models\UserAccount;
use App\Modules\Students\Models\Student;
use App\Modules\Students\Models\StudentStatus;
use App\Support\Identifiers\RandomIdentifier;
use Illuminate\Support\Facades\Hash;
use Tests\Concerns\BuildsActors;
use Tests\TestCase;

/**
 * The flagship end-to-end employee console scenario, exercised over the real
 * HTTP surface: an authenticated admissions clerk registers a verified
 * person as an applicant, a three-signature decision admits them, the
 * admitted applicant converts to a student, and the student is visible with
 * its status. This proves the Discover→Enter→Confirm→Result workflow through
 * the intended interface, with authorization enforced server-side.
 */
final class ConsoleWorkflowFeatureTest extends TestCase
{
    use BuildsActors;

    /** @return array{0: Person, 1: UserAccount} */
    private function makeEmployee(string $personId, array $capabilities, string $username): array
    {
        $person = $this->personWithAuthority($personId, $capabilities);
        $account = UserAccount::query()->create([
            'id' => RandomIdentifier::new(),
            'person_id' => $person->id,
            'username' => $username,
            'password_hash' => Hash::make('console-password-1'),
            'account_state' => UserAccount::STATE_ACTIVE,
        ]);

        return [$person, $account];
    }

    public function test_admissions_lifecycle_end_to_end_through_the_console(): void
    {
        // The signed-in clerk initiates; reviewer and approver are distinct
        // people, as the admission decision requires (SoD).
        [$clerk] = $this->makeEmployee('clerk-1', ['admissions.register', 'admissions.initiate', 'admissions.approve'], 'clerk');
        [$reviewer] = $this->makeEmployee('rev-1', ['admissions.review'], 'reviewer');
        [$approver] = $this->makeEmployee('appr-1', ['admissions.approve'], 'approver');

        // The prospective student, verified.
        $applicantPerson = Person::query()->create([
            'id' => 'applicant-person-1',
            'legal_name' => 'Prospective Student',
            'date_of_birth' => '2000-05-05',
            'verification_state' => Person::VERIFICATION_VERIFIED,
        ]);

        // Sign in as the clerk.
        $this->post('/login', ['username' => 'clerk', 'password' => 'console-password-1'])->assertRedirect('/');
        $this->assertAuthenticated();

        // Discover + home.
        $this->get('/')->assertOk();

        // Register the applicant.
        $this->post('/students/applicants', [
            'person_id' => $applicantPerson->id,
            'program_interest' => 'TOEFL Intensive',
        ])->assertRedirect(route('students.applicants'));

        $applicant = Applicant::query()->where('person_id', $applicantPerson->id)->firstOrFail();
        $this->assertSame('applicant', $applicant->lifecycle_state);

        // Three-signature decision (clerk initiates; distinct reviewer/approver).
        $this->post('/students/applicants/'.$applicant->id.'/decide', [
            'decision' => 'admit',
            'reason' => 'Meets placement criteria',
            'evidence_ref' => 'placement-assessment-2026-08',
            'reviewer_id' => $reviewer->id,
            'approver_id' => $approver->id,
        ])->assertRedirect(route('students.applicants'));

        $applicant->refresh();
        $this->assertSame('admitted', $applicant->lifecycle_state);

        // Enroll the admitted applicant as a student.
        $this->post('/students/applicants/'.$applicant->id.'/enroll')
            ->assertRedirect(route('students.applicants'));

        $student = Student::query()->where('person_id', $applicantPerson->id)->firstOrFail();
        $status = StudentStatus::query()->where('student_id', $student->id)->firstOrFail();
        $this->assertSame('active', $status->status);

        // The student is discoverable in the console.
        $this->get('/students')->assertOk()->assertSee($student->student_code);
        $this->get('/students/students/'.$student->id)->assertOk();
    }

    public function test_decision_rejects_non_distinct_actors(): void
    {
        [$clerk] = $this->makeEmployee('clerk-2', ['admissions.register', 'admissions.initiate'], 'clerk2');
        // One person who holds BOTH review and approve: legitimate capabilities,
        // but using them for both seats violates the distinct-actor rule.
        [$combo] = $this->makeEmployee('combo-1', ['admissions.review', 'admissions.approve'], 'combo');
        $applicantPerson = Person::query()->create([
            'id' => 'applicant-person-2',
            'legal_name' => 'Second Prospect',
            'date_of_birth' => '2001-01-01',
            'verification_state' => Person::VERIFICATION_VERIFIED,
        ]);

        $this->post('/login', ['username' => 'clerk2', 'password' => 'console-password-1'])->assertRedirect('/');
        $this->post('/students/applicants', [
            'person_id' => $applicantPerson->id,
            'program_interest' => 'General',
        ])->assertRedirect();
        $applicant = Applicant::query()->where('person_id', $applicantPerson->id)->firstOrFail();

        // Reviewer and approver are the same person → separation-of-duties denial.
        $this->post('/students/applicants/'.$applicant->id.'/decide', [
            'decision' => 'admit',
            'reason' => 'attempt',
            'evidence_ref' => 'e-1',
            'reviewer_id' => $combo->id,
            'approver_id' => $combo->id,
        ])->assertRedirect();

        $this->assertNotSame('admitted', $applicant->refresh()->lifecycle_state);
    }

    public function test_anonymous_cannot_reach_any_workflow_route(): void
    {
        foreach (['/students', '/students/applicants', '/finance', '/payroll', '/reporting', '/library', '/hr', '/academic'] as $path) {
            $this->get($path)->assertRedirect('/login');
        }
    }
}
