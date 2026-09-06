<?php

declare(strict_types=1);

namespace Tests\Feature\Crm;

use App\Modules\Identity\Models\UserAccount;
use App\Support\Identifiers\RandomIdentifier;
use Illuminate\Support\Facades\Hash;
use Tests\Concerns\BuildsActors;
use Tests\TestCase;

final class CrmConsoleFeatureTest extends TestCase
{
    use BuildsActors;

    private function signInAs(string $personId, string $username): void
    {
        UserAccount::query()->create([
            'id' => RandomIdentifier::new(),
            'person_id' => $personId,
            'username' => $username,
            'password_hash' => Hash::make('crm-console-password'),
            'account_state' => UserAccount::STATE_ACTIVE,
        ]);
        $this->post('/login', ['username' => $username, 'password' => 'crm-console-password'])->assertRedirect('/');
    }

    public function test_employee_console_lists_the_crm_page(): void
    {
        $staff = $this->personWithAuthority('crm-console-1', ['crm.visitor']);
        $this->signInAs($staff->id, 'crm.console');

        $this->get('/crm')
            ->assertOk()
            ->assertSee('Visitor / Lead CRM');
    }

    public function test_employee_console_captures_a_visitor_through_the_command_surface(): void
    {
        $staff = $this->personWithAuthority('crm-console-2', ['crm.visitor']);
        $this->signInAs($staff->id, 'crm.console.capture');

        $this->post('/crm/visitors', [
            'full_name' => 'Console Visitor',
            'phone' => '+93 799 111 222',
            'preferred_channel' => 'phone',
            'visitor_type' => 'walk_in',
        ])->assertRedirect('/crm');

        $this->assertDatabaseHas('visitors', ['full_name' => 'Console Visitor']);
    }
}
