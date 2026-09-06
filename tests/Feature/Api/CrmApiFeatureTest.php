<?php

declare(strict_types=1);

namespace Tests\Feature\Api;

use App\Modules\Identity\Models\UserAccount;
use App\Support\Identifiers\RandomIdentifier;
use Illuminate\Support\Facades\Hash;
use Tests\Concerns\BuildsActors;
use Tests\TestCase;

final class CrmApiFeatureTest extends TestCase
{
    use BuildsActors;

    private function signInAs(string $personId, string $username): void
    {
        UserAccount::query()->create([
            'id' => RandomIdentifier::new(),
            'person_id' => $personId,
            'username' => $username,
            'password_hash' => Hash::make('crm-password-1'),
            'account_state' => UserAccount::STATE_ACTIVE,
        ]);
        $this->post('/login', ['username' => $username, 'password' => 'crm-password-1'])->assertRedirect('/');
    }

    public function test_api_captures_and_lists_a_visitor(): void
    {
        $staff = $this->personWithAuthority('api-crm-1', ['crm.visitor']);
        $this->signInAs($staff->id, 'api.crm');

        $this->postJson('/api/crm/visitors', [
            'full_name' => 'API Visitor',
            'phone' => '+93 777 000 111',
            'preferred_channel' => 'phone',
            'visitor_type' => 'walk_in',
        ])->assertCreated()
            ->assertJsonStructure(['visitor_id', 'visitor_code', 'status', 'correlation_id']);

        $this->assertDatabaseHas('visitors', ['full_name' => 'API Visitor']);

        $this->getJson('/api/crm/visitors?statuses[]=new')
            ->assertOk()
            ->assertJsonCount(1, 'visitors')
            ->assertJsonPath('visitors.0.full_name', 'API Visitor');
    }

    public function test_api_forbids_a_visitor_operation_without_crm_capability(): void
    {
        $nobody = $this->personWithAuthority('api-crm-nobody-1', []);
        $this->signInAs($nobody->id, 'api.crm.nobody');

        $this->postJson('/api/crm/visitors', [
            'full_name' => 'Denied Visitor',
            'email' => 'denied@example.com',
            'preferred_channel' => 'email',
            'visitor_type' => 'online',
        ])->assertForbidden()
            ->assertJsonPath('category', 'authorization');
    }
}
