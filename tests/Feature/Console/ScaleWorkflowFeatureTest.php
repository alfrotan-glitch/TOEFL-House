<?php

declare(strict_types=1);

namespace Tests\Feature\Console;

use App\Modules\Identity\Models\Person;
use App\Modules\Identity\Models\UserAccount;
use App\Support\Identifiers\RandomIdentifier;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Hash;
use Tests\Concerns\BuildsActors;
use Tests\TestCase;

/**
 * PHASE_3 increment E (part four): the compensation scale catalog over the
 * HR console — scales register with a unique key and rank order, retire
 * without deleting (historical payroll never depends on the catalog
 * staying active), and are audited.
 */
final class ScaleWorkflowFeatureTest extends TestCase
{
    use BuildsActors;

    /** @return array{0: Person, 1: UserAccount} */
    private function makeEmployee(string $personId, array $capabilities, string $username): array
    {
        $person = $this->personWithAuthority($personId, $capabilities);
        $account = UserAccount::query()->create([
            'id' => RandomIdentifier::new(),
            'person_id' => $person->id,
            'username' => $username,
            'password_hash' => Hash::make('acw-password-1'),
            'account_state' => UserAccount::STATE_ACTIVE,
        ]);

        return [$person, $account];
    }

    private function signIn(string $username): void
    {
        $this->post('/login', ['username' => $username, 'password' => 'acw-password-1'])->assertRedirect('/');
        $this->assertAuthenticated();
    }

    private function signOut(): void
    {
        $this->post('/logout')->assertRedirect('/login');
        $this->assertGuest();
    }

    public function test_the_scale_catalog_over_the_console(): void
    {
        $this->makeEmployee('acw-scale-1', ['hr.scale'], 'scale-1');
        $this->makeEmployee('acw-plain-3', [], 'plain-3');

        $scales = DB::connection()->getTablePrefix().'scales';

        // An employee without the capability cannot register scales.
        $this->signIn('plain-3');
        $this->post('/hr/scales', [
            'key' => 'ACW-T1', 'name' => 'Teacher 1', 'rank_order' => 1,
        ], ['referer' => 'http://localhost/hr'])
            ->assertRedirect('/hr')
            ->assertSessionHas('error_code', 'hr.scale_denied');
        $this->assertDatabaseHas('audit_events', ['operation' => 'hr.scale.register.denied', 'actor_id' => 'acw-plain-3']);

        $this->signOut();
        $this->signIn('scale-1');
        $this->post('/hr/scales', [
            'key' => 'ACW-T1', 'name' => 'Teacher 1', 'rank_order' => 1,
        ])->assertRedirect('/hr');
        $scaleId = DB::table($scales)->where('key', 'ACW-T1')->value('id');
        $this->assertDatabaseHas($scales, ['id' => $scaleId, 'lifecycle_state' => 'active', 'rank_order' => 1]);

        // The catalog key and the rank order are both unique.
        $this->post('/hr/scales', [
            'key' => 'ACW-T1', 'name' => 'Duplicate key', 'rank_order' => 2,
        ], ['referer' => 'http://localhost/hr'])
            ->assertRedirect('/hr')
            ->assertSessionHas('error_code', 'hr.scale_duplicate');
        $this->post('/hr/scales', [
            'key' => 'ACW-T2', 'name' => 'Duplicate rank', 'rank_order' => 1,
        ], ['referer' => 'http://localhost/hr'])
            ->assertRedirect('/hr')
            ->assertSessionHas('error_code', 'hr.scale_rank_duplicate');

        // A retired scale stays in the catalog as history; it cannot be
        // retired twice.
        $this->post('/hr/scales/'.$scaleId.'/retire')->assertRedirect('/hr');
        $this->assertDatabaseHas($scales, ['id' => $scaleId, 'lifecycle_state' => 'retired']);
        $this->post('/hr/scales/'.$scaleId.'/retire', [], ['referer' => 'http://localhost/hr'])
            ->assertRedirect('/hr')
            ->assertSessionHas('error_code', 'hr.scale_not_active');
    }
}
