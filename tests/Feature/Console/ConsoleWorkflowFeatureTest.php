<?php

declare(strict_types=1);

namespace Tests\Feature\Console;

use App\Modules\Admissions\Models\AdmissionDecision;
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
 * The flagship end-to-end employee console scenario, exercised over the
 * real HTTP surface: an authenticated admissions clerk registers a verified
 * person as an applicant and INITIATES a decision; a DIFFERENT session
 * signed in as the reviewer reviews it; a THIRD session signed in as the
 * approver finalizes it; the admitted applicant converts to a student.
 *
 * Each signature is captured in its own authenticated session — the
 * transport has no field for typing a colleague's person id — and only the
 * third signature transitions the applicant.
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

    private function signIn(string $username): void
    {
        $this->post('/login', ['username' => $username, 'password' => 'console-password-1'])->assertRedirect('/');
        $this->assertAuthenticated();
    }

    private function signOut(): void
    {
        $this->post('/logout')->assertRedirect('/login');
        $this->assertGuest();
    }

    public function test_admissions_lifecycle_end_to_end_through_the_console(): void
    {
        // Three distinct employees, one session per signature.
        [$clerk] = $this->makeEmployee('clerk-1', ['admissions.register', 'admissions.initiate'], 'clerk');
        [$reviewer] = $this->makeEmployee('rev-1', ['admissions.review'], 'reviewer');
        [$approver] = $this->makeEmployee('appr-1', ['admissions.approve'], 'approver');

        // The prospective student, verified.
        $applicantPerson = Person::query()->create([
            'id' => 'applicant-person-1',
            'legal_name' => 'Prospective Student',
            'date_of_birth' => '2000-05-05',
            'verification_state' => Person::VERIFICATION_VERIFIED,
            'identity_key' => 'fixture-applicant-person-1',
            'identity_evidence_ref' => 'evidence/fixture/applicant-person-1',
            'verified_by' => 'fixture-verifier',
            'verified_at' => now()->toDateTimeString(),
        ]);

        // Sign in as the clerk.
        $this->signIn('clerk');

        // Discover + home.
        $this->get('/')->assertOk();

        // Register the applicant.
        $this->post('/students/applicants', [
            'person_id' => $applicantPerson->id,
            'program_interest' => 'TOEFL Intensive',
        ])->assertRedirect(route('students.applicants'));

        $applicant = Applicant::query()->where('person_id', $applicantPerson->id)->firstOrFail();
        $this->assertSame('applicant', $applicant->lifecycle_state);

        // Stage 1: the clerk INITIATES (no person-id fields on the form).
        // The decision is born proposed; the applicant is not touched yet.
        $this->post('/students/applicants/'.$applicant->id.'/initiate', [
            'decision' => 'admit',
            'reason' => 'Meets placement criteria',
            'evidence_ref' => 'placement-assessment-2026-08',
        ])->assertRedirect(route('students.applicants'));

        $decision = AdmissionDecision::query()->where('applicant_id', $applicant->id)->firstOrFail();
        $this->assertSame('proposed', $decision->lifecycle_state);
        $this->assertSame('clerk-1', trim((string) $decision->initiator_id));
        $this->assertNull($decision->reviewer_id);
        $this->assertNull($decision->approver_id);
        $this->assertSame('applicant', $applicant->refresh()->lifecycle_state);

        // Stage 2: a DIFFERENT session, signed in as the reviewer.
        $this->signOut();
        $this->signIn('reviewer');
        $this->post('/students/decisions/'.$decision->id.'/review')->assertRedirect(route('students.applicants'));

        $decision->refresh();
        $this->assertSame('reviewed', $decision->lifecycle_state);
        $this->assertSame('rev-1', trim((string) $decision->reviewer_id));
        $this->assertSame('applicant', $applicant->refresh()->lifecycle_state);

        // Stage 3: a THIRD session, signed in as the approver — only now
        // does the applicant become admitted.
        $this->signOut();
        $this->signIn('approver');
        $this->post('/students/decisions/'.$decision->id.'/approve')->assertRedirect(route('students.applicants'));

        $decision->refresh();
        $this->assertSame('final', $decision->lifecycle_state);
        $this->assertSame('appr-1', trim((string) $decision->approver_id));
        $this->assertSame('admitted', $applicant->refresh()->lifecycle_state);

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

    public function test_one_session_cannot_carry_two_decision_stages(): void
    {
        [$clerk] = $this->makeEmployee('clerk-2', ['admissions.register', 'admissions.initiate'], 'clerk2');
        // One person who holds BOTH review and approve: legitimate
        // capabilities, but carrying both seats violates the distinct-actor
        // rule — the schema and the commands enforce it per stage.
        [$combo] = $this->makeEmployee('combo-1', ['admissions.review', 'admissions.approve'], 'combo');
        $applicantPerson = Person::query()->create([
            'id' => 'applicant-person-2',
            'legal_name' => 'Second Prospect',
            'date_of_birth' => '2001-01-01',
            'verification_state' => Person::VERIFICATION_VERIFIED,
            'identity_key' => 'fixture-applicant-person-2',
            'identity_evidence_ref' => 'evidence/fixture/applicant-person-2',
            'verified_by' => 'fixture-verifier',
            'verified_at' => now()->toDateTimeString(),
        ]);

        $this->signIn('clerk2');
        $this->post('/students/applicants', [
            'person_id' => $applicantPerson->id,
            'program_interest' => 'General',
        ])->assertRedirect();
        $applicant = Applicant::query()->where('person_id', $applicantPerson->id)->firstOrFail();

        // The clerk initiates...
        $this->post('/students/applicants/'.$applicant->id.'/initiate', [
            'decision' => 'admit',
            'reason' => 'attempt',
            'evidence_ref' => 'e-1',
        ])->assertRedirect();
        $decision = AdmissionDecision::query()->where('applicant_id', $applicant->id)->firstOrFail();
        $this->assertSame('proposed', $decision->lifecycle_state);

        // ...but cannot review their own proposal (no review capability).
        $this->post('/students/decisions/'.$decision->id.'/review')->assertRedirect();
        $decision->refresh();
        $this->assertSame('proposed', $decision->lifecycle_state);

        // A real reviewer advances it to 'reviewed'...
        $this->signOut();
        $this->signIn('combo');
        $this->post('/students/decisions/'.$decision->id.'/review')->assertRedirect();
        $decision->refresh();
        $this->assertSame('reviewed', $decision->lifecycle_state);

        // ...but the reviewer cannot be the approver of their own review.
        $this->post('/students/decisions/'.$decision->id.'/approve')->assertRedirect();
        $decision->refresh();
        $this->assertSame('reviewed', $decision->lifecycle_state);
        $this->assertNull($decision->approver_id);
        $this->assertSame('applicant', $applicant->refresh()->lifecycle_state);
    }

    public function test_anonymous_cannot_reach_any_workflow_route(): void
    {
        foreach (['/students', '/students/applicants', '/finance', '/payroll', '/reporting', '/library', '/hr', '/academic'] as $path) {
            $this->get($path)->assertRedirect('/login');
        }

        // The staged mutation endpoints are session-gated too.
        $this->post('/students/applicants/some-applicant/initiate')->assertRedirect('/login');
        $this->post('/students/decisions/some-decision/review')->assertRedirect('/login');
        $this->post('/students/decisions/some-decision/approve')->assertRedirect('/login');
        $this->post('/finance/refunds/some-refund/approve')->assertRedirect('/login');
    }
}
