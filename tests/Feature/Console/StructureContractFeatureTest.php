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
 * PHASE_3 coverage matrix, increment A: the academic structure (programs,
 * versions, periods, skills) and the full hire path (employment → contract
 * draft → sign → hire → terminate) become operable through the console.
 * Before this increment the console advertised these records read-only and
 * the hire path was dead past contract-version approval — hire() requires
 * an active signed contract that no transport could create.
 */
final class StructureContractFeatureTest extends TestCase
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
            'password_hash' => Hash::make('scf-password-1'),
            'account_state' => UserAccount::STATE_ACTIVE,
        ]);

        return [$person, $account];
    }

    private function signIn(string $username): void
    {
        $this->post('/login', ['username' => $username, 'password' => 'scf-password-1'])->assertRedirect('/');
        $this->assertAuthenticated();
    }

    public function test_academic_structure_and_skills_through_the_console(): void
    {
        $this->makeEmployee('scf-acad-1', ['academic.structure', 'academic.skill'], 'acad-keeper');
        $this->signIn('acad-keeper');

        $this->post('/academic/programs', ['name' => 'IELTS Foundation'])->assertRedirect('/academic');
        $programId = DB::table(DB::connection()->getTablePrefix().'programs')->where('name', 'IELTS Foundation')->value('id');
        $this->assertNotNull($programId);

        $this->post('/academic/programs/'.$programId.'/versions', ['summary' => 'entry level, 4 skills'])->assertRedirect('/academic');
        $this->assertDatabaseHas(DB::connection()->getTablePrefix().'program_versions', [
            'program_id' => $programId, 'summary' => 'entry level, 4 skills',
        ]);

        $this->post('/academic/periods', [
            'name' => 'Fall 2026', 'starts_on' => '2026-09-01', 'ends_on' => '2026-12-18',
        ])->assertRedirect('/academic');
        $periodId = DB::table(DB::connection()->getTablePrefix().'academic_periods')->where('name', 'Fall 2026')->value('id');
        $this->assertDatabaseHas(DB::connection()->getTablePrefix().'academic_periods', [
            'id' => $periodId, 'lifecycle_state' => 'draft',
        ]);

        $this->post('/academic/periods/'.$periodId.'/transition', ['to_state' => 'published'])->assertRedirect('/academic');
        $this->assertDatabaseHas(DB::connection()->getTablePrefix().'academic_periods', [
            'id' => $periodId, 'lifecycle_state' => 'published',
        ]);

        // The state machine is domain-owned: draft->published->published is not a transition.
        $this->post('/academic/periods/'.$periodId.'/transition', ['to_state' => 'published'], ['referer' => 'http://localhost/academic'])
            ->assertRedirect('/academic')
            ->assertSessionHas('error_code', 'academic.period_transition_forbidden');

        $this->post('/academic/skills', ['key' => 'reading_foundation', 'name' => 'Reading Foundation'])->assertRedirect('/academic');
        $skillId = DB::table(DB::connection()->getTablePrefix().'skills')->where('key', 'reading_foundation')->value('id');
        $this->post('/academic/skills/'.$skillId.'/retire')->assertRedirect('/academic');
        $this->assertDatabaseHas(DB::connection()->getTablePrefix().'skills', [
            'id' => $skillId, 'lifecycle_state' => 'retired',
        ]);

        $this->post('/academic/skills/'.$skillId.'/retire', [], ['referer' => 'http://localhost/academic'])
            ->assertRedirect('/academic')
            ->assertSessionHas('error_code', 'academic.skill_not_active');
    }

    public function test_hire_path_is_operable_through_the_console(): void
    {
        $this->makeEmployee('scf-hr-1', ['hr.employ', 'hr.contract', 'hr.terminate'], 'hr-keeper');
        $person = $this->personWithAuthority('scf-teacher-1', []);
        $this->signIn('hr-keeper');

        $this->post('/hr/employ', ['person_id' => $person->id])->assertRedirect('/hr');
        $employmentId = DB::table(DB::connection()->getTablePrefix().'employments')->where('person_id', $person->id)->value('id');
        $this->assertDatabaseHas(DB::connection()->getTablePrefix().'employments', [
            'id' => $employmentId, 'lifecycle_state' => 'candidate',
        ]);

        $this->post('/hr/contracts/draft', [
            'employment_id' => $employmentId,
            'terms_summary' => 'S2 standard, 5 sessions per week',
            'effective_from' => '2026-09-01',
        ])->assertRedirect('/hr/contracts');
        $contractId = DB::table(DB::connection()->getTablePrefix().'contracts')->where('employment_id', $employmentId)->value('id');
        $this->assertDatabaseHas(DB::connection()->getTablePrefix().'contracts', [
            'id' => $contractId, 'lifecycle_state' => 'draft',
        ]);

        // Without a signed contract the hire would be rejected (hr.hire_requires_contract);
        // signing through the console is now the only missing step.
        $this->post('/hr/contracts/'.$contractId.'/sign', ['signed_ref' => 'contract/scf-2026-09-signed.pdf'])->assertRedirect('/hr/contracts');
        $this->assertDatabaseHas(DB::connection()->getTablePrefix().'contracts', [
            'id' => $contractId, 'lifecycle_state' => 'active',
        ]);

        $this->post('/hr/employments/hire', [
            'employment_id' => $employmentId,
            'effective_from' => '2026-09-01',
        ])->assertRedirect('/hr');
        $this->assertDatabaseHas(DB::connection()->getTablePrefix().'employments', [
            'id' => $employmentId, 'lifecycle_state' => 'active',
        ]);
    }

    public function test_termination_through_the_console_unlocks_settlement_path(): void
    {
        $this->makeEmployee('scf-hr-2', ['hr.employ', 'hr.contract', 'hr.terminate'], 'hr-keeper-2');
        $person = $this->personWithAuthority('scf-teacher-2', []);
        $this->signIn('hr-keeper-2');

        $this->post('/hr/employ', ['person_id' => $person->id])->assertRedirect('/hr');
        $employmentId = DB::table(DB::connection()->getTablePrefix().'employments')->where('person_id', $person->id)->value('id');

        $this->post('/hr/contracts/draft', [
            'employment_id' => $employmentId,
            'terms_summary' => 'S1 junior, 3 sessions per week',
            'effective_from' => '2026-09-01',
        ])->assertRedirect('/hr/contracts');
        $contractId = DB::table(DB::connection()->getTablePrefix().'contracts')->where('employment_id', $employmentId)->value('id');
        $this->post('/hr/contracts/'.$contractId.'/sign', ['signed_ref' => 'contract/scf-2-2026-09-signed.pdf'])->assertRedirect('/hr/contracts');
        $this->post('/hr/employments/hire', [
            'employment_id' => $employmentId,
            'effective_from' => '2026-09-01',
        ])->assertRedirect('/hr');

        $this->post('/hr/employments/terminate', [
            'employment_id' => $employmentId,
            'effective_from' => '2026-12-01',
            'reason' => 'contract ended',
        ])->assertRedirect('/hr');
        $this->assertDatabaseHas(DB::connection()->getTablePrefix().'employments', [
            'id' => $employmentId, 'lifecycle_state' => 'terminated',
        ]);
        // Termination closes the active contract automatically (domain rule).
        $this->assertDatabaseHas(DB::connection()->getTablePrefix().'contracts', [
            'id' => $contractId, 'lifecycle_state' => 'closed',
        ]);
    }
}
