<?php

declare(strict_types=1);

namespace App\Modules\Identity\Queries;

use App\Modules\Identity\Models\Person;
use App\Modules\Identity\Models\UserAccount;
use Illuminate\Support\Collection;

/**
 * Read model of the person directory: verified identities with their account
 * history. Read-only and scope-free at package 02; list authorization
 * filters arrive with the authorization package.
 */
final class PersonDirectoryQuery
{
    /**
     * @return array<string, mixed>|null
     */
    public function personDetail(string $personId): ?array
    {
        /** @var Person|null $person */
        $person = Person::query()->whereKey($personId)->first();
        if ($person === null) {
            return null;
        }

        /** @var Collection<int, UserAccount> $accounts */
        $accounts = UserAccount::query()->where('person_id', $person->id)->get();

        return [
            'id' => $person->id,
            'legal_name' => $person->legal_name,
            'date_of_birth' => $person->date_of_birth,
            'verification_state' => $person->verification_state,
            'identity_key' => $person->identity_key,
            'user_accounts' => $accounts->map(fn (UserAccount $account): array => [
                'id' => $account->id,
                'username' => $account->username,
                'account_state' => $account->account_state,
            ])->all(),
        ];
    }

    /**
     * @return list<array<string, mixed>>
     */
    public function verifiedPersons(): array
    {
        return Person::query()
            ->where('verification_state', Person::VERIFICATION_VERIFIED)
            ->orderBy('legal_name')
            ->get(['id', 'legal_name', 'identity_key'])
            ->map(fn (Person $person): array => [
                'id' => $person->id,
                'legal_name' => $person->legal_name,
                'identity_key' => $person->identity_key,
            ])
            ->all();
    }
}
