<?php

declare(strict_types=1);

namespace Tests\Feature\Identity;

use App\Modules\Identity\Models\Person;
use App\Modules\Identity\Models\UserAccount;
use App\Support\Identifiers\RandomIdentifier;
use Illuminate\Support\Facades\Hash;
use Tests\Concerns\BuildsActors;
use Tests\TestCase;

/**
 * Credential management over the console: an identity administrator sets a
 * password for an issued account, and the employee can then sign in. The
 * operation is authorized (identity.admin), idempotent, and audited; an
 * actor without the capability is denied without side effects.
 */
final class CredentialManagementFeatureTest extends TestCase
{
    use BuildsActors;

    private function makeAccount(string $username, ?string $password = null, ?Person $person = null): UserAccount
    {
        if ($person === null) {
            $personId = RandomIdentifier::new();
            $person = Person::query()->create([
                'id' => $personId,
                'legal_name' => 'Account Holder',
                'date_of_birth' => '1991-01-01',
                'verification_state' => Person::VERIFICATION_VERIFIED,
                'identity_key' => 'fixture-'.$personId,
                'identity_evidence_ref' => 'evidence/fixture/'.$personId,
                'verified_by' => 'fixture-verifier',
                'verified_at' => now()->toDateTimeString(),
            ]);
        }

        return UserAccount::query()->create([
            'id' => RandomIdentifier::new(),
            'person_id' => $person->id,
            'username' => $username,
            'password_hash' => $password !== null ? Hash::make($password) : null,
            'account_state' => UserAccount::STATE_ACTIVE,
        ]);
    }

    private function signIn(string $username, string $password): void
    {
        $this->post('/login', ['username' => $username, 'password' => $password])->assertRedirect('/');
    }

    public function test_admin_sets_password_and_employee_can_sign_in(): void
    {
        $adminPerson = $this->personWithAuthority('cred-admin-1', ['identity.admin']);
        $this->makeAccount('cred.admin', 'admin-password-1', $adminPerson);
        $target = $this->makeAccount('new.employee'); // no password yet

        $this->signIn('cred.admin', 'admin-password-1');

        $this->post(route('identity.password', $target->id), [
            'password' => 'fresh-credential-99',
        ])->assertRedirect(route('identity.index'));

        $target->refresh();
        $this->assertNotNull($target->password_hash);
        $this->assertTrue(Hash::check('fresh-credential-99', $target->password_hash));

        // The newly credentialed employee can now sign in.
        $this->post('/logout');
        $this->signIn('new.employee', 'fresh-credential-99');
        $this->assertAuthenticated();
    }

    public function test_non_admin_cannot_set_a_password(): void
    {
        $intruder = $this->personWithAuthority('cred-nobody-1', []);
        $this->makeAccount('cred.nobody', 'nobody-password-1', $intruder);
        $target = $this->makeAccount('protected.employee');

        $this->signIn('cred.nobody', 'nobody-password-1');

        $this->post(route('identity.password', $target->id), [
            'password' => 'evil-credential-12',
        ])->assertRedirect();

        $target->refresh();
        $this->assertNull($target->password_hash);
    }

    public function test_set_password_rejects_too_short_credential(): void
    {
        $adminPerson2 = $this->personWithAuthority('cred-admin-2', ['identity.admin']);
        $this->makeAccount('cred.admin2', 'admin-password-2', $adminPerson2);
        $target = $this->makeAccount('short.employee');

        $this->signIn('cred.admin2', 'admin-password-2');

        $this->post(route('identity.password', $target->id), [
            'password' => 'short',
        ])->assertRedirect();

        $target->refresh();
        $this->assertNull($target->password_hash);
    }
}
