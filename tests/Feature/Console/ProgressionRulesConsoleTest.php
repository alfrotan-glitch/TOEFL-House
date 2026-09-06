<?php

declare(strict_types=1);

namespace Tests\Feature\Console;

use App\Modules\Academic\Commands\MaintainAcademicStructure;
use App\Modules\Academic\Models\Program;
use App\Modules\Identity\Models\UserAccount;
use App\Support\Identifiers\RandomIdentifier;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Hash;
use Tests\Concerns\BuildsActors;
use Tests\TestCase;

/**
 * AC12: the certified level-governance surface is operational through the
 * employee console. Defining and retiring progression rules (pass mark +
 * repeat cap, one active rule per level) and prerequisites (same-version,
 * self-require and cycle refusals), plus governed capability denials, are
 * exercised over the real HTTP surface; the domain guards themselves are
 * not re-implemented.
 */
final class ProgressionRulesConsoleTest extends TestCase
{
    use BuildsActors;

    private string $starterId;

    private string $elementaryId;

    private string $preId;

    private string $otherVersionLevelId;

    protected function setUp(): void
    {
        parent::setUp();

        $officer = $this->academicOfficer('pr-console-setup');
        $structure = app(MaintainAcademicStructure::class);

        $program = $structure->defineProgram($officer, 'Rules Intensive', 'pr-prog');
        $programModel = Program::query()->findOrFail($program['program_id']);
        $version = $structure->publishVersion($officer, $programModel, 'Rules v1', 'pr-ver');
        $version2 = $structure->publishVersion($officer, $programModel, 'Rules v2', 'pr-ver-2');

        $this->starterId = $structure->defineLevel($officer, $version['version_id'], 'starter', 1, 'Starter', 'A1', 'pr-lvl-1')['level_id'];
        $this->elementaryId = $structure->defineLevel($officer, $version['version_id'], 'elementary', 2, 'Elementary', 'A2', 'pr-lvl-2')['level_id'];
        $this->preId = $structure->defineLevel($officer, $version['version_id'], 'pre', 3, 'Pre-Intermediate', 'A2+', 'pr-lvl-3')['level_id'];
        $this->otherVersionLevelId = $structure->defineLevel($officer, $version2['version_id'], 'starter', 1, 'Starter', 'A1', 'pr-lvl-x')['level_id'];

        $this->makeEmployee('pr-officer-1', ['academic.structure'], 'rules-officer');
        $this->makeEmployee('pr-stranger-1', [], 'rules-stranger');
    }

    private function makeEmployee(string $personId, array $capabilities, string $username): void
    {
        $person = $this->personWithAuthority($personId, $capabilities);
        UserAccount::query()->create([
            'id' => RandomIdentifier::new(),
            'person_id' => $person->id,
            'username' => $username,
            'password_hash' => Hash::make('pr-password-1'),
            'account_state' => UserAccount::STATE_ACTIVE,
        ]);
    }

    private function signIn(string $username): void
    {
        $this->post('/login', ['username' => $username, 'password' => 'pr-password-1'])->assertRedirect('/');
        $this->assertAuthenticated();
    }

    private function signOut(): void
    {
        $this->post('/logout')->assertRedirect('/login');
        $this->assertGuest();
    }

    private function ruleId(string $levelId): string
    {
        /** @var string $id */
        $id = DB::table('level_progression_rules')->where('program_version_level_id', $levelId)->value('id');
        $this->assertNotNull($id);

        return $id;
    }

    private function prerequisiteId(string $targetId, string $requiredId): string
    {
        /** @var string $id */
        $id = DB::table('level_prerequisites')->where('target_level_id', $targetId)->where('required_level_id', $requiredId)->value('id');
        $this->assertNotNull($id);

        return $id;
    }

    public function test_progression_rule_lifecycle_through_console(): void
    {
        $this->signIn('rules-officer');
        $this->get('/academic')->assertOk()->assertSee('Level progression rules');

        $this->post('/academic/levels/rules', [
            'program_version_level_id' => $this->starterId,
            'minimum_passing_score' => '60',
            'max_repeats' => 2,
        ])->assertRedirect('/academic');
        $this->assertDatabaseHas('level_progression_rules', [
            'id' => $this->ruleId($this->starterId),
            'minimum_passing_score' => 60,
            'max_repeats' => 2,
            'lifecycle_state' => 'active',
        ]);

        // A level holds at most one active rule.
        $this->post('/academic/levels/rules', [
            'program_version_level_id' => $this->starterId,
            'minimum_passing_score' => '70',
        ], ['referer' => 'http://localhost/academic'])
            ->assertRedirect('/academic')
            ->assertSessionHas('error_code', 'academic.progression_rule_exists');

        // Retiring closes the rule; a retired rule cannot retire again,
        // and retirement frees the level for a fresh rule.
        $this->post('/academic/levels/rules/'.$this->ruleId($this->starterId).'/retire')->assertRedirect('/academic');
        $this->assertDatabaseHas('level_progression_rules', ['id' => $this->ruleId($this->starterId), 'lifecycle_state' => 'retired']);
        $this->post('/academic/levels/rules/'.$this->ruleId($this->starterId).'/retire', [], ['referer' => 'http://localhost/academic'])
            ->assertRedirect('/academic')
            ->assertSessionHas('error_code', 'academic.progression_rule_not_active');

        $this->post('/academic/levels/rules', [
            'program_version_level_id' => $this->starterId,
            'max_repeats' => 3,
        ])->assertRedirect('/academic');
        $this->assertDatabaseHas('level_progression_rules', [
            'program_version_level_id' => $this->starterId,
            'max_repeats' => 3,
            'lifecycle_state' => 'active',
        ]);
        $this->assertDatabaseHas('audit_events', ['operation' => 'academic.progression_rule.define']);
        $this->assertDatabaseHas('audit_events', ['operation' => 'academic.progression_rule.retire']);
        $this->signOut();
    }

    public function test_prerequisite_lifecycle_through_console(): void
    {
        $this->signIn('rules-officer');
        $referer = ['referer' => 'http://localhost/academic'];

        $this->post('/academic/levels/prerequisites', [
            'target_level_id' => $this->elementaryId,
            'required_level_id' => $this->starterId,
        ])->assertRedirect('/academic');
        $this->assertDatabaseHas('level_prerequisites', [
            'id' => $this->prerequisiteId($this->elementaryId, $this->starterId),
            'lifecycle_state' => 'active',
        ]);

        // The same active pair cannot be declared twice.
        $this->post('/academic/levels/prerequisites', [
            'target_level_id' => $this->elementaryId,
            'required_level_id' => $this->starterId,
        ], $referer)
            ->assertRedirect('/academic')
            ->assertSessionHas('error_code', 'academic.prerequisite_exists');

        // A level cannot require itself.
        $this->post('/academic/levels/prerequisites', [
            'target_level_id' => $this->elementaryId,
            'required_level_id' => $this->elementaryId,
        ], $referer)
            ->assertRedirect('/academic')
            ->assertSessionHas('error_code', 'academic.prerequisite_self');

        // Closing the loop back is a cycle even through two edges.
        $this->post('/academic/levels/prerequisites', [
            'target_level_id' => $this->starterId,
            'required_level_id' => $this->elementaryId,
        ], $referer)
            ->assertRedirect('/academic')
            ->assertSessionHas('error_code', 'academic.prerequisite_cycle');

        // Prerequisites never cross program versions.
        $this->post('/academic/levels/prerequisites', [
            'target_level_id' => $this->starterId,
            'required_level_id' => $this->otherVersionLevelId,
        ], $referer)
            ->assertRedirect('/academic')
            ->assertSessionHas('error_code', 'academic.prerequisite_cross_version');

        // Retiring closes the edge; only an active edge can retire, and
        // retirement frees the pair for a fresh declaration.
        $this->post('/academic/levels/prerequisites/'.$this->prerequisiteId($this->elementaryId, $this->starterId).'/retire')->assertRedirect('/academic');
        $this->assertDatabaseHas('level_prerequisites', [
            'id' => $this->prerequisiteId($this->elementaryId, $this->starterId),
            'lifecycle_state' => 'retired',
        ]);
        $this->post('/academic/levels/prerequisites/'.$this->prerequisiteId($this->elementaryId, $this->starterId).'/retire', [], $referer)
            ->assertRedirect('/academic')
            ->assertSessionHas('error_code', 'academic.prerequisite_not_active');

        $this->post('/academic/levels/prerequisites', [
            'target_level_id' => $this->elementaryId,
            'required_level_id' => $this->starterId,
        ])->assertRedirect('/academic');
        $this->assertDatabaseHas('audit_events', ['operation' => 'academic.prerequisite.define']);
        $this->assertDatabaseHas('audit_events', ['operation' => 'academic.prerequisite.retire']);
        $this->signOut();
    }

    public function test_rule_governance_is_denied_governed(): void
    {
        $this->signIn('rules-stranger');
        $referer = ['referer' => 'http://localhost/academic'];

        $this->post('/academic/levels/rules', [
            'program_version_level_id' => $this->preId,
            'minimum_passing_score' => '50',
        ], $referer)
            ->assertRedirect('/academic')
            ->assertSessionHas('error_code', 'academic.structure_denied');
        $this->assertDatabaseHas('audit_events', [
            'actor_id' => 'pr-stranger-1',
            'operation' => 'academic.progression_rule.define.denied',
            'target_type' => 'level_progression_rule',
            'target_id' => $this->preId,
        ]);

        $this->post('/academic/levels/prerequisites', [
            'target_level_id' => $this->preId,
            'required_level_id' => $this->elementaryId,
        ], $referer)
            ->assertRedirect('/academic')
            ->assertSessionHas('error_code', 'academic.structure_denied');

        $this->assertSame(0, DB::table('level_progression_rules')->where('program_version_level_id', $this->preId)->count());
        $this->assertSame(0, DB::table('level_prerequisites')->where('target_level_id', $this->preId)->count());
        $this->signOut();
    }
}
