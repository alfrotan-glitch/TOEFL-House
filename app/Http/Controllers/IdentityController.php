<?php

declare(strict_types=1);

namespace App\Http\Controllers;

use App\Modules\Identity\Commands\LinkUserAccount;
use App\Modules\Identity\Commands\SetAccountPassword;
use App\Modules\Identity\Commands\VerifyPerson;
use App\Modules\Identity\Models\Person;
use App\Modules\Identity\Models\UserAccount;
use Illuminate\Http\RedirectResponse;
use Illuminate\Http\Request;
use Illuminate\View\View;

/**
 * Identity &amp; Access console: verify people, issue user accounts, and set
 * credentials. All three delegate to the identity module commands, which own
 * authorization (identity.verify / identity.admin), validation, idempotency,
 * and audit.
 */
final class IdentityController extends Controller
{
    public function index(): View
    {
        return view('identity.index', [
            'people' => Person::query()->orderBy('legal_name')->limit(200)->get(),
            'accounts' => UserAccount::query()->orderBy('username')->limit(200)->get(),
        ]);
    }

    public function verifyPerson(Request $request, string $personId): RedirectResponse
    {
        $input = $request->validate([
            'identity_key' => ['required', 'string', 'max:120'],
            'evidence_ref' => ['required', 'string', 'max:255'],
        ]);
        $person = Person::query()->findOrFail($personId);

        app(VerifyPerson::class)->verify(
            $this->actor(),
            $person,
            $input['identity_key'],
            $input['evidence_ref'],
            $this->idempotencyKey('identity.verify'),
        );

        return redirect()->route('identity.index')->with('success', 'Person verified and the verification is recorded.');
    }

    public function linkAccount(Request $request): RedirectResponse
    {
        $input = $request->validate([
            'person_id' => ['required', 'string'],
            'username' => ['required', 'string', 'max:120'],
        ]);
        $person = Person::query()->findOrFail($input['person_id']);

        app(LinkUserAccount::class)->link(
            $this->actor(),
            $person,
            $input['username'],
            $this->idempotencyKey('identity.link'),
        );

        return redirect()->route('identity.index')->with('success', 'User account issued. Set a password to enable sign-in.');
    }

    public function setPassword(Request $request, string $accountId): RedirectResponse
    {
        $input = $request->validate([
            'password' => ['required', 'string', 'min:'.SetAccountPassword::MIN_PASSWORD_LENGTH, 'max:255'],
        ]);
        $account = UserAccount::query()->findOrFail($accountId);

        app(SetAccountPassword::class)->set(
            $this->actor(),
            $account,
            $input['password'],
            $this->idempotencyKey('identity.password'),
        );

        return redirect()->route('identity.index')->with('success', 'Credential set for '.$account->username.'. The employee can now sign in.');
    }
}
