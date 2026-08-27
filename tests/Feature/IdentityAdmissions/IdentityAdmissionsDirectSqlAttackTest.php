<?php

declare(strict_types=1);

namespace Tests\Feature\IdentityAdmissions;

use App\Modules\Admissions\Commands\RegisterApplicant;
use App\Modules\Admissions\Models\Applicant;
use App\Modules\Identity\Commands\VerifyPerson;
use App\Modules\Identity\Models\Person;
use Illuminate\Database\QueryException;
use Illuminate\Support\Facades\DB;
use Tests\Concerns\BuildsActors;
use Tests\Concerns\DecidesAdmissions;
use Tests\TestCase;

/**
 * Direct-SQL attack surface for the identity-verification and admission
 * decision guards. Every fixture state is built through the legitimate
 * domain commands; the attack is a raw INSERT/UPDATE that bypasses the
 * application. The schema — not the application — must reject each
 * forged identity or decision.
 */
final class IdentityAdmissionsDirectSqlAttackTest extends TestCase
{
    use BuildsActors;
    use DecidesAdmissions;

    private string $personId = 'idatk-person-1';

    private Person $applicantPerson;

    protected function setUp(): void
    {
        parent::setUp();

        // Unverified identity: the target of the verification-forgery
        // attacks. A raw flip to verified without decision evidence must
        // be rejected by the schema.
        Person::query()->create([
            'id' => $this->personId,
            'legal_name' => 'Attack Target Person',
            'date_of_birth' => '1995-01-01',
            'verification_state' => Person::VERIFICATION_UNVERIFIED,
        ]);

        // Verified applicant: the target of the admission-forgery attacks.
        $this->applicantPerson = $this->personWithAuthority('idatk-applicant-1', []);
    }

    public function test_direct_sql_cannot_forge_verification_without_evidence(): void
    {
        // A raw flip to verified without any decision evidence must fail.
        $this->expectException(QueryException::class);
        DB::table('people')->where('id', $this->personId)->update(['verification_state' => 'verified']);
    }

    public function test_direct_sql_cannot_rewrite_a_verified_identity(): void
    {
        app(VerifyPerson::class)->verify($this->identityVerifier(), Person::query()->findOrFail($this->personId), 'NID-0001', 'evidence/nid/0001', 'idatk-verify-1');
        $this->assertSame('verified', Person::query()->findOrFail($this->personId)->verification_state);

        // Verified persons are final: identity evidence cannot be rewritten.
        $this->expectException(QueryException::class);
        DB::table('people')->where('id', $this->personId)->update(['identity_key' => 'NID-9999']);
    }

    public function test_direct_sql_cannot_insert_a_verified_person_without_evidence(): void
    {
        $this->expectException(QueryException::class);
        DB::table('people')->insert([
            'id' => 'dddddddd-eeee-4fff-8000-000000000001',
            'legal_name' => 'Ghost Verified Person',
            'date_of_birth' => '1990-01-01',
            'verification_state' => 'verified',
        ]);
    }

    public function test_direct_sql_cannot_forge_a_single_actor_admission_decision(): void
    {
        $registered = app(RegisterApplicant::class)->register($this->admissionsClerk(), $this->applicantPerson->id, 'TOEFL Intensive', 'idatk-reg-1');
        $applicantId = $registered['applicant_id'];

        // A well-shaped PROPOSAL by the forger gets in...
        DB::table('admission_decisions')->insert([
            'id' => 'dddddddd-eeee-4fff-8000-000000000002',
            'applicant_id' => $applicantId,
            'outcome' => 'admit',
            'reason' => 'raw sql admission',
            'evidence_ref' => 'evidence/forged',
            'initiator_id' => 'idatk-forger-1',
            'lifecycle_state' => 'proposed',
            'created_at' => now(), 'updated_at' => now(),
        ]);

        // ...but one actor playing all three roles must be rejected at the
        // review stage (reviewer may not equal the initiator).
        $this->expectException(QueryException::class);
        DB::statement('UPDATE admission_decisions SET lifecycle_state = ?, reviewer_id = ? WHERE id = ?', [
            'reviewed', 'idatk-forger-1', 'dddddddd-eeee-4fff-8000-000000000002',
        ]);
    }

    public function test_direct_sql_cannot_skip_the_review_stage(): void
    {
        $registered = app(RegisterApplicant::class)->register($this->admissionsClerk(), $this->applicantPerson->id, 'TOEFL Intensive', 'idatk-reg-3');
        $applicantId = $registered['applicant_id'];

        DB::table('admission_decisions')->insert([
            'id' => 'dddddddd-eeee-4fff-8000-000000000004',
            'applicant_id' => $applicantId,
            'outcome' => 'admit',
            'reason' => 'raw sql admission',
            'evidence_ref' => 'evidence/forged',
            'initiator_id' => 'idatk-init-2',
            'lifecycle_state' => 'proposed',
            'created_at' => now(), 'updated_at' => now(),
        ]);

        // proposed -> final in one statement skips the review stage:
        // rejected, and the applicant must stay put.
        try {
            DB::statement('UPDATE admission_decisions SET lifecycle_state = ?, approver_id = ? WHERE id = ?', [
                'final', 'idatk-appr-2', 'dddddddd-eeee-4fff-8000-000000000004',
            ]);
            $this->fail('skipping the review stage must be rejected');
        } catch (QueryException) {
            $this->assertSame('applicant', Applicant::query()->findOrFail($applicantId)->lifecycle_state);
        }
    }

    public function test_direct_sql_cannot_finalize_a_decision_with_a_self_approving_chain(): void
    {
        $registered = app(RegisterApplicant::class)->register($this->admissionsClerk(), $this->applicantPerson->id, 'TOEFL Intensive', 'idatk-reg-4');
        $applicantId = $registered['applicant_id'];

        DB::table('admission_decisions')->insert([
            'id' => 'dddddddd-eeee-4fff-8000-000000000005',
            'applicant_id' => $applicantId,
            'outcome' => 'admit',
            'reason' => 'raw sql admission',
            'evidence_ref' => 'evidence/forged',
            'initiator_id' => 'idatk-init-3',
            'lifecycle_state' => 'proposed',
            'created_at' => now(), 'updated_at' => now(),
        ]);
        DB::statement('UPDATE admission_decisions SET lifecycle_state = ?, reviewer_id = ? WHERE id = ?', [
            'reviewed', 'idatk-rev-3', 'dddddddd-eeee-4fff-8000-000000000005',
        ]);

        // The approver may not equal the initiator or the reviewer.
        try {
            DB::statement('UPDATE admission_decisions SET lifecycle_state = ?, approver_id = ? WHERE id = ?', [
                'final', 'idatk-rev-3', 'dddddddd-eeee-4fff-8000-000000000005',
            ]);
            $this->fail('a self-approving chain must be rejected');
        } catch (QueryException) {
            $this->assertSame('applicant', Applicant::query()->findOrFail($applicantId)->lifecycle_state);
        }
    }

    public function test_finalizing_a_decision_transitions_the_applicant_at_the_schema_boundary(): void
    {
        $registered = app(RegisterApplicant::class)->register($this->admissionsClerk(), $this->applicantPerson->id, 'TOEFL Intensive', 'idatk-reg-5');
        $applicantId = $registered['applicant_id'];

        DB::table('admission_decisions')->insert([
            'id' => 'dddddddd-eeee-4fff-8000-000000000006',
            'applicant_id' => $applicantId,
            'outcome' => 'admit',
            'reason' => 'raw sql admission',
            'evidence_ref' => 'evidence/forged',
            'initiator_id' => 'idatk-init-4',
            'lifecycle_state' => 'proposed',
            'created_at' => now(), 'updated_at' => now(),
        ]);
        DB::statement('UPDATE admission_decisions SET lifecycle_state = ?, reviewer_id = ? WHERE id = ?', [
            'reviewed', 'idatk-rev-4', 'dddddddd-eeee-4fff-8000-000000000006',
        ]);
        DB::statement('UPDATE admission_decisions SET lifecycle_state = ?, approver_id = ? WHERE id = ?', [
            'final', 'idatk-appr-4', 'dddddddd-eeee-4fff-8000-000000000006',
        ]);

        // Finalization IS the applicant transition, even via direct SQL:
        // no statement can declare a decision final while the applicant
        // stays in the decidable state.
        $this->assertSame('admitted', Applicant::query()->findOrFail($applicantId)->lifecycle_state);
        $this->assertDatabaseHas('admission_decisions', ['id' => 'dddddddd-eeee-4fff-8000-000000000006', 'lifecycle_state' => 'final']);
    }

    public function test_direct_sql_cannot_decide_an_already_decided_applicant(): void
    {
        $registered = app(RegisterApplicant::class)->register($this->admissionsClerk(), $this->applicantPerson->id, 'TOEFL Intensive', 'idatk-reg-2');
        $applicant = Applicant::query()->findOrFail($registered['applicant_id']);
        $this->runAdmissionDecision($this->admissionsClerk(), $this->admissionsReviewer(), $this->admissionsApprover(), $applicant, true, 'meets entry policy', 'interview-notes/1', 'idatk-dec-1');
        $this->assertSame('admitted', Applicant::query()->findOrFail($registered['applicant_id'])->lifecycle_state);

        // A second, well-shaped proposal for an already-admitted applicant
        // must still be rejected.
        $this->expectException(QueryException::class);
        DB::table('admission_decisions')->insert([
            'id' => 'dddddddd-eeee-4fff-8000-000000000003',
            'applicant_id' => $registered['applicant_id'],
            'outcome' => 'admit',
            'reason' => 'duplicate raw sql decision',
            'evidence_ref' => 'evidence/duplicate',
            'initiator_id' => 'idatk-init-1',
            'lifecycle_state' => 'proposed',
            'created_at' => now(), 'updated_at' => now(),
        ]);
    }
}
