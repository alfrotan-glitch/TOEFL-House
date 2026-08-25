<?php

declare(strict_types=1);

namespace Tests\Feature\Identity;

use App\Modules\Identity\Commands\LinkUserAccount;
use App\Modules\Identity\Commands\VerifyPerson;
use App\Modules\Identity\Models\Person;
use App\Modules\Identity\Models\UserAccount;
use App\Support\Errors\BusinessRejection;
use App\Support\Identifiers\RandomIdentifier;
use Illuminate\Support\Facades\DB;
use Tests\Concerns\BuildsActors;
use Tests\TestCase;

/**
 * Adversarial suite of the identity boundary: duplicate verified identity,
 * duplicate active accounts, and username collisions must all fail closed.
 */
final class DuplicateIdentityAdversarialTest extends TestCase
{
    use BuildsActors;

    private function newPerson(string $legalName): Person
    {
        /** @var Person $person */
        $person = Person::query()->create([
            'id' => RandomIdentifier::new(),
            'legal_name' => $legalName,
            'date_of_birth' => '1990-01-01',
            'verification_state' => Person::VERIFICATION_UNVERIFIED,
        ]);

        return $person;
    }

    public function test_a_second_verified_person_with_the_same_identity_key_is_rejected(): void
    {
        $first = $this->newPerson('First Human');
        $second = $this->newPerson('Second Human');
        app(VerifyPerson::class)->verify($this->identityVerifier(), $first, 'national-id-1001', 'documents/national-id-1001', RandomIdentifier::new());

        $this->expectException(BusinessRejection::class);
        $this->expectExceptionMessage('identity key already belongs to a verified person');
        app(VerifyPerson::class)->verify($this->identityVerifier(), $second, 'national-id-1001', 'documents/national-id-1001', RandomIdentifier::new());
    }

    public function test_reverification_of_the_same_person_is_rejected(): void
    {
        $person = $this->newPerson('Once Verified');
        app(VerifyPerson::class)->verify($this->identityVerifier(), $person, 'national-id-2002', 'documents/national-id-2002', RandomIdentifier::new());

        $this->expectException(BusinessRejection::class);
        $this->expectExceptionMessage('person identity is already verified');
        app(VerifyPerson::class)->verify($this->identityVerifier(), $person, 'national-id-2002', 'documents/national-id-2002', RandomIdentifier::new());
    }

    public function test_second_active_account_for_one_person_is_rejected(): void
    {
        $person = $this->newPerson('One Account Only');
        app(VerifyPerson::class)->verify($this->identityVerifier(), $person, 'national-id-3003', 'documents/national-id-3003', RandomIdentifier::new());
        app(LinkUserAccount::class)->link($this->identityAdministrator(), $person, 'first.account', RandomIdentifier::new());

        $this->expectException(BusinessRejection::class);
        $this->expectExceptionMessage('username is taken or person already has an active account');
        app(LinkUserAccount::class)->link($this->identityAdministrator(), $person, 'second.account', RandomIdentifier::new());
    }

    public function test_username_collision_across_persons_is_rejected(): void
    {
        $first = $this->newPerson('Username Owner');
        $second = $this->newPerson('Username Claimant');
        app(VerifyPerson::class)->verify($this->identityVerifier(), $first, 'national-id-4004', 'documents/national-id-4004', RandomIdentifier::new());
        app(VerifyPerson::class)->verify($this->identityVerifier(), $second, 'national-id-5005', 'documents/national-id-5005', RandomIdentifier::new());
        app(LinkUserAccount::class)->link($this->identityAdministrator(), $first, 'shared.username', RandomIdentifier::new());

        $this->expectException(BusinessRejection::class);
        $this->expectExceptionMessage('username is taken or person already has an active account');
        app(LinkUserAccount::class)->link($this->identityAdministrator(), $second, 'shared.username', RandomIdentifier::new());
    }

    public function test_deactivated_account_frees_the_person_for_a_new_active_account(): void
    {
        $person = $this->newPerson('Returning User');
        app(VerifyPerson::class)->verify($this->identityVerifier(), $person, 'national-id-6006', 'documents/national-id-6006', RandomIdentifier::new());
        $first = app(LinkUserAccount::class)->link($this->identityAdministrator(), $person, 'historic.user', RandomIdentifier::new());

        DB::table('user_accounts')->where('id', $first['account_id'])->update([
            'account_state' => 'deactivated',
            'deactivated_at' => now(),
            'deactivation_reason' => 'test setup',
        ]);

        $second = app(LinkUserAccount::class)->link($this->identityAdministrator(), $person, 'returning.user', RandomIdentifier::new());
        $this->assertDatabaseHas('user_accounts', ['id' => $second['account_id'], 'account_state' => 'active']);
        $this->assertSame(2, UserAccount::query()->where('person_id', $person->id)->count());
    }
}
