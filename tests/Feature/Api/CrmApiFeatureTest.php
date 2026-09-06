<?php

declare(strict_types=1);

namespace Tests\Feature\Api;

use App\Modules\Identity\Models\UserAccount;
use App\Modules\Organization\Models\Branch;
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

        $this->postJson('/api/v1/crm/visitors', [
            'full_name' => 'API Visitor',
            'phone' => '+93 777 000 111',
            'preferred_channel' => 'phone',
            'visitor_type' => 'walk_in',
        ])->assertCreated()
            ->assertJsonStructure(['visitor_id', 'visitor_code', 'status', 'correlation_id']);

        $this->assertDatabaseHas('visitors', ['full_name' => 'API Visitor']);

        $this->getJson('/api/v1/crm/visitors?statuses[]=new')
            ->assertOk()
            ->assertJsonCount(1, 'visitors')
            ->assertJsonPath('visitors.0.full_name', 'API Visitor');
    }

    public function test_organization_scope_lists_all_active_provenanced_branches(): void
    {
        $staff = $this->personWithAuthority('api-crm-org-reader', []);
        $this->grantScopeAuthority($staff->id, ['crm.visitor'], 'organization', '00000000-0000-4000-8000-00000000b005');
        $branchA = Branch::query()->create(['id' => RandomIdentifier::new(), 'name' => 'CRM API Org A', 'lifecycle_state' => 'active']);
        $branchB = Branch::query()->create(['id' => RandomIdentifier::new(), 'name' => 'CRM API Org B', 'lifecycle_state' => 'active']);
        $this->attachBranchToBootstrapOrganization($branchA->id);
        $this->attachBranchToBootstrapOrganization($branchB->id);
        $this->signInAs($staff->id, 'api.crm.org');

        foreach ([[$branchA->id, 'org-a@example.com'], [$branchB->id, 'org-b@example.com']] as [$branchId, $email]) {
            $this->postJson('/api/v1/crm/visitors', [
                'full_name' => 'Organization Visitor',
                'email' => $email,
                'preferred_channel' => 'email',
                'visitor_type' => 'online',
                'origin_branch_id' => $branchId,
            ])->assertCreated();
        }

        $this->getJson('/api/v1/crm/visitors?statuses[]=new')
            ->assertOk()
            ->assertJsonCount(2, 'visitors');
    }

    public function test_api_forbids_a_visitor_operation_without_crm_capability(): void
    {
        $nobody = $this->personWithAuthority('api-crm-nobody-1', []);
        $this->signInAs($nobody->id, 'api.crm.nobody');

        $this->postJson('/api/v1/crm/visitors', [
            'full_name' => 'Denied Visitor',
            'email' => 'denied@example.com',
            'preferred_channel' => 'email',
            'visitor_type' => 'online',
        ])->assertForbidden()
            ->assertJsonPath('category', 'authorization');
    }
}
