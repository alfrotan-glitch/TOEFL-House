<?php

declare(strict_types=1);

namespace Tests\Feature\IdentityAdmissions;

use App\Modules\Admissions\Commands\DecideAdmission;
use App\Modules\Admissions\Commands\RegisterApplicant;
use App\Modules\Admissions\Models\Applicant;
use App\Modules\Identity\Commands\VerifyPerson;
use App\Modules\Identity\Models\Person;
use Illuminate\Database\QueryException;
use Illuminate\Support\Facades\DB;
use Tests\Concerns\BuildsActors;
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

        // One actor playing all three decision roles must be rejected.
        $this->expectException(QueryException::class);
        DB::table('admission_decisions')->insert([
            'id' => 'dddddddd-eeee-4fff-8000-000000000002',
            'applicant_id' => $applicantId,
            'outcome' => 'admit',
            'reason' => 'raw sql admission',
            'evidence_ref' => 'evidence/forged',
            'initiator_id' => 'idatk-forger-1',
            'reviewer_id' => 'idatk-forger-1',
            'approver_id' => 'idatk-forger-1',
            'created_at' => now(), 'updated_at' => now(),
        ]);
    }

    public function test_direct_sql_cannot_decide_an_already_decided_applicant(): void
    {
        $registered = app(RegisterApplicant::class)->register($this->admissionsClerk(), $this->applicantPerson->id, 'TOEFL Intensive', 'idatk-reg-2');
        $applicant = Applicant::query()->findOrFail($registered['applicant_id']);
        app(DecideAdmission::class)->decide($this->admissionsClerk(), $this->admissionsReviewer(), $this->admissionsApprover(), $applicant, true, 'meets entry policy', 'interview-notes/1', 'idatk-dec-1');
        $this->assertSame('admitted', Applicant::query()->findOrFail($registered['applicant_id'])->lifecycle_state);

        // A second, properly-shaped decision for an already-admitted
        // applicant must still be rejected.
        $this->expectException(QueryException::class);
        DB::table('admission_decisions')->insert([
            'id' => 'dddddddd-eeee-4fff-8000-000000000003',
            'applicant_id' => $registered['applicant_id'],
            'outcome' => 'admit',
            'reason' => 'duplicate raw sql decision',
            'evidence_ref' => 'evidence/duplicate',
            'initiator_id' => 'idatk-init-1',
            'reviewer_id' => 'idatk-rev-1',
            'approver_id' => 'idatk-appr-1',
            'created_at' => now(), 'updated_at' => now(),
        ]);
    }
}
