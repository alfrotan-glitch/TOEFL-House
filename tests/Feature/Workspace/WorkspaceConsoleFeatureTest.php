<?php

declare(strict_types=1);

namespace Tests\Feature\Workspace;

use App\Modules\Identity\Models\UserAccount;
use App\Support\Identifiers\RandomIdentifier;
use Illuminate\Support\Facades\Hash;
use Tests\Concerns\BuildsActors;
use Tests\TestCase;

final class WorkspaceConsoleFeatureTest extends TestCase
{
    use BuildsActors;

    private function signInAs(string $personId, string $username): void
    {
        UserAccount::query()->create([
            'id' => RandomIdentifier::new(),
            'person_id' => $personId,
            'username' => $username,
            'password_hash' => Hash::make('workspace-password'),
            'account_state' => UserAccount::STATE_ACTIVE,
        ]);
        $this->post('/login', ['username' => $username, 'password' => 'workspace-password'])->assertRedirect('/');
    }

    public function test_employee_and_management_shells_share_the_react_boundary(): void
    {
        $staff = $this->personWithAuthority('workspace-console-1', []);
        $this->signInAs($staff->id, 'workspace.console');

        $this->get('/workspace')
            ->assertOk()
            ->assertSee('data-view="workspace"')
            ->assertSee('react-console');

        $this->get('/management')
            ->assertOk()
            ->assertSee('data-view="management"')
            ->assertSee('react-console');
    }
}
