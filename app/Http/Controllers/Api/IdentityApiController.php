<?php

declare(strict_types=1);

namespace App\Http\Controllers\Api;

use App\Http\Controllers\Controller;
use App\Modules\Identity\Commands\LinkUserAccount;
use App\Modules\Identity\Commands\SetAccountPassword;
use App\Modules\Identity\Commands\VerifyPerson;
use App\Modules\Identity\Models\Person;
use App\Modules\Identity\Models\UserAccount;
use Illuminate\Http\JsonResponse;
use Illuminate\Http\Request;

/** JSON interface for identity & access (delegates to the same commands). */
final class IdentityApiController extends Controller
{
    public function people(): JsonResponse
    {
        $people = Person::query()->orderBy('legal_name')->limit(300)->get(['id', 'legal_name', 'verification_state']);

        return response()->json(['people' => $people]);
    }

    public function verify(Request $request, string $personId): JsonResponse
    {
        $input = $request->validate([
            'identity_key' => ['required', 'string', 'max:120'],
            'evidence_ref' => ['required', 'string', 'max:255'],
        ]);

        app(VerifyPerson::class)->verify(
            $this->actor(),
            Person::query()->findOrFail($personId),
            $input['identity_key'],
            $input['evidence_ref'],
            $this->idempotencyKey('identity.verify'),
        );

        return response()->json(['status' => 'verified']);
    }

    public function link(Request $request): JsonResponse
    {
        $input = $request->validate([
            'person_id' => ['required', 'string'],
            'username' => ['required', 'string', 'max:120'],
        ]);

        app(LinkUserAccount::class)->link(
            $this->actor(),
            Person::query()->findOrFail($input['person_id']),
            $input['username'],
            $this->idempotencyKey('identity.link'),
        );

        return response()->json(['status' => 'linked'], 201);
    }

    public function password(Request $request, string $accountId): JsonResponse
    {
        $input = $request->validate([
            'password' => ['required', 'string', 'min:'.SetAccountPassword::MIN_PASSWORD_LENGTH, 'max:255'],
        ]);

        app(SetAccountPassword::class)->set(
            $this->actor(),
            UserAccount::query()->findOrFail($accountId),
            $input['password'],
            $this->idempotencyKey('identity.password'),
        );

        return response()->json(['status' => 'set']);
    }
}
