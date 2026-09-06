<?php

declare(strict_types=1);

namespace Tests\Feature\Identity;

use App\Modules\Identity\Commands\DeactivateUserAccount;
use App\Modules\Identity\Commands\LinkUserAccount;
use App\Modules\Identity\Commands\VerifyPerson;
use App\Modules\Identity\Models\Person;
use App\Modules\Identity\Models\UserAccount;
use App\Support\Errors\AuthorizationDenied;
use App\Support\Errors\BusinessRejection;
use App\Support\Identifiers\RandomIdentifier;
use Tests\Concerns\BuildsActors;
use Tests\TestCase;

final class IdentityCommandFeatureTest extends TestCase
{
    use BuildsActors;

    private function newPerson(string $legalName = 'Sara Ahmadi', string $dateOfBirth = '1998-04-12'): Person
    {
        /** @var Person $person */
        $person = Person::query()->create([
            'id' => RandomIdentifier::new(),
            'legal_name' => $legalName,
            'date_of_birth' => $dateOfBirth,
            'verification_state' => Person::VERIFICATION_UNVERIFIED,
        ]);

        return $person;
    }

    public function test_verification_writes_the_identity_key_exactly_once(): void
    {
        $person = $this->newPerson();

        $outcome = app(VerifyPerson::class)->verify(
            $this->identityVerifier(),
            $person,
            'passport-8723AA19',
            'documents/passport-8723AA19',
            RandomIdentifier::new(),
        );

        $this->assertSame($person->id, $outcome['person_id']);
        $this->assertDatabaseHas('people', [
            'id' => $person->id,
            'verification_state' => 'verified',
            'identity_key' => 'passport-8723AA19',
        ]);
        $this->assertDatabaseHas('audit_events', [
            'operation' => 'identity.verify',
            'target_type' => 'person',
            'target_id' => $person->id,
        ]);
    }

    public function test_account_linking_requires_a_verified_person(): void
    {
        $person = $this->newPerson('Unverified Person');

        $this->expectException(BusinessRejection::class);
        $this->expectExceptionMessage('user account requires a verified person');
        app(LinkUserAccount::class)->link($this->identityAdministrator(), $person, 'unverified.user', RandomIdentifier::new());
    }

    public function test_account_linking_persists_an_active_account_with_audit_evidence(): void
    {
        $person = $this->newPerson();
        app(VerifyPerson::class)->verify($this->identityVerifier(), $person, 'id-card-5512', 'documents/id-card-5512', RandomIdentifier::new());

        $outcome = app(LinkUserAccount::class)->link($this->identityAdministrator(), $person, 'sara.ahmadi', RandomIdentifier::new());

        $this->assertDatabaseHas('user_accounts', [
            'id' => $outcome['account_id'],
            'person_id' => $person->id,
            'username' => 'sara.ahmadi',
            'account_state' => 'active',
        ]);
        $this->assertDatabaseHas('audit_events', [
            'operation' => 'identity.link_account',
            'target_type' => 'person',
            'target_id' => $person->id,
        ]);
    }

    public function test_deactivation_retains_the_account_history(): void
    {
        $person = $this->newPerson();
        app(VerifyPerson::class)->verify($this->identityVerifier(), $person, 'id-card-9001', 'documents/id-card-9001', RandomIdentifier::new());
        $linked = app(LinkUserAccount::class)->link($this->identityAdministrator(), $person, 'leaving.user', RandomIdentifier::new());

        /** @var UserAccount $account */
        $account = UserAccount::query()->findOrFail($linked['account_id']);
        $outcome = app(DeactivateUserAccount::class)->deactivate($this->identityAdministrator(), $account, 'employment ended', RandomIdentifier::new());

        $this->assertSame('deactivated', $outcome['account_state']);
        $this->assertDatabaseHas('user_accounts', ['id' => $account->id, 'account_state' => 'deactivated']);
        $this->assertSame(1, UserAccount::query()->where('id', $account->id)->count());
        $this->assertDatabaseHas('audit_events', [
            'operation' => 'identity.deactivate_account',
            'target_type' => 'user_account',
            'target_id' => $account->id,
        ]);
    }

    public function test_deactivation_of_a_deactivated_account_fails_closed(): void
    {
        $person = $this->newPerson();
        app(VerifyPerson::class)->verify($this->identityVerifier(), $person, 'id-card-7777', 'documents/id-card-7777', RandomIdentifier::new());
        $linked = app(LinkUserAccount::class)->link($this->identityAdministrator(), $person, 'double.user', RandomIdentifier::new());
        /** @var UserAccount $account */
        $account = UserAccount::query()->findOrFail($linked['account_id']);
        app(DeactivateUserAccount::class)->deactivate($this->identityAdministrator(), $account, 'first deactivation', RandomIdentifier::new());

        $this->expectException(BusinessRejection::class);
        $this->expectExceptionMessage('only an active account can be deactivated');
        app(DeactivateUserAccount::class)->deactivate($this->identityAdministrator(), $account, 'second deactivation', RandomIdentifier::new());
    }

    public function test_unprivileged_verifier_is_denied_and_the_denial_is_audited(): void
    {
        $person = $this->newPerson('Target Person');

        try {
            app(VerifyPerson::class)->verify($this->actorWithoutAnyCapability(), $person, 'id-card-1', 'documents/x', RandomIdentifier::new());
            $this->fail('verification must be denied without the identity capability');
        } catch (AuthorizationDenied) {
        }

        $this->assertDatabaseHas('people', ['id' => $person->id, 'verification_state' => 'unverified']);
        $this->assertDatabaseHas('audit_events', [
            'operation' => 'identity.verify.denied',
            'target_type' => 'person',
            'target_id' => $person->id,
        ]);
    }
}
