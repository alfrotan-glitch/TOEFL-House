<?php

declare(strict_types=1);

namespace Tests\Feature\Api;

use App\Modules\Identity\Models\UserAccount;
use App\Modules\Organization\Models\Branch;
use App\Modules\Students\Models\Student;
use App\Support\Identifiers\RandomIdentifier;
use Illuminate\Support\Facades\Hash;
use Tests\Concerns\BuildsStudents;
use Tests\TestCase;

/**
 * API read-branch confinement (WP-ACAD-SCOPE): list endpoints disclose only
 * rows of the actor's visible branches (plus null-provenance rows to
 * authorized actors, empty output to bare sessions), and single-record reads
 * outside scope are refused with 403 and denial-audited.
 */
final class ApiBranchScopeTest extends TestCase
{
    use BuildsStudents;

    private string $branchA;

    private string $branchB;

    private string $studentA;

    private string $studentB;

    private string $studentNull;

    protected function setUp(): void
    {
        parent::setUp();

        $this->branchA = $this->newBranch('API Branch A');
        $this->branchB = $this->newBranch('API Branch B');

        $this->studentA = $this->makeStudent()['student']->id;
        $this->studentB = $this->makeStudent()['student']->id;
        $this->studentNull = $this->makeStudent()['student']->id;
        Student::query()->whereKey($this->studentA)->update(['current_home_branch_id' => $this->branchA]);
        Student::query()->whereKey($this->studentB)->update(['current_home_branch_id' => $this->branchB]);

        $this->makeLogin('api.a', 'api-officer-a', $this->branchA);
        $this->makeLogin('api.bare', 'api-officer-bare', null);
    }

    private function newBranch(string $name): string
    {
        $id = Branch::query()->create([
            'id' => RandomIdentifier::new(),
            'name' => $name.' '.substr(md5(RandomIdentifier::new()), 0, 8),
            'lifecycle_state' => 'active',
        ])->id;
        $this->attachBranchToBootstrapOrganization($id);

        return $id;
    }

    private function makeLogin(string $username, string $personId, ?string $branchId): void
    {
        if ($branchId === null) {
            $this->personWithAuthority($personId, []);
        } else {
            $this->personWithAuthority($personId, []);
            $this->grantScopeAuthority($personId, ['academic.enroll'], 'branch', $branchId);
        }
        UserAccount::query()->create([
            'id' => RandomIdentifier::new(),
            'person_id' => $personId,
            'username' => $username,
            'password_hash' => Hash::make('api-password-1'),
            'account_state' => UserAccount::STATE_ACTIVE,
        ]);
    }

    private function signIn(string $username): void
    {
        $this->post('/login', ['username' => $username, 'password' => 'api-password-1'])->assertRedirect('/');
    }

    /** @return list<string> */
    private function listedStudentIds(): array
    {
        $payload = $this->getJson('/api/students')->assertOk()->json();

        return collect($payload['students'] ?? [])->pluck('id')->all();
    }

    public function test_student_list_confines_rows_to_visible_branches(): void
    {
        $this->signIn('api.a');
        $ids = $this->listedStudentIds();

        $this->assertContains($this->studentA, $ids);
        $this->assertContains($this->studentNull, $ids);
        $this->assertNotContains($this->studentB, $ids);
    }

    public function test_student_list_is_empty_without_read_authority(): void
    {
        $this->signIn('api.bare');
        $payload = $this->getJson('/api/students')->assertOk()->json();

        $this->assertSame([], $payload['students']);
        $this->assertSame([], $payload['applicants']);
    }

    public function test_single_student_read_outside_scope_is_refused_and_denial_audited(): void
    {
        $this->signIn('api.a');

        $this->getJson('/api/students/'.$this->studentB)
            ->assertForbidden()
            ->assertJsonPath('error', 'api.read_denied');
        $this->assertDatabaseHas('audit_events', [
            'operation' => 'api.students.show.denied',
            'actor_id' => 'api-officer-a',
        ]);

        $this->getJson('/api/students/'.$this->studentA)->assertOk();
        $this->getJson('/api/students/'.$this->studentNull)->assertOk();
    }
}
