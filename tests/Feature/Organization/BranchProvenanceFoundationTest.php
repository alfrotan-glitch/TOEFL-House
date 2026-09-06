<?php

declare(strict_types=1);

namespace Tests\Feature\Organization;

use App\Modules\Organization\Models\Branch;
use App\Modules\Students\Models\Student;
use App\Support\Identifiers\RandomIdentifier;
use Illuminate\Database\QueryException;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Schema;
use Tests\Concerns\BuildsStudents;
use Tests\TestCase;

/**
 * WP-2 F1 (WP2-DEC-01) foundation invariants.
 *
 * Provenance is immutable once assigned (a later branch transfer must never
 * rewrite history), and a NULL provenance is the first-class unassigned state —
 * never fabricated to one branch. The cross-branch affected-scope junction
 * (branch_scope_links) cannot self-link, permits at most one OPEN link per
 * owner branch, and history is append-only via close-then-open.
 */
final class BranchProvenanceFoundationTest extends TestCase
{
    use BuildsStudents;

    public function test_provenance_can_be_assigned_once_but_never_rewritten(): void
    {
        $student = $this->makeStudent()['student'];
        $branchA = $this->makeBranch('f1-branch-a');
        $branchB = $this->makeBranch('f1-branch-b');

        // Unassigned provenance is the explicit initial state — never fabricated.
        $this->assertNull($student->originating_branch_id);

        // First assignment from NULL is allowed.
        $this->updateOriginatingBranch($student, $branchA->id);
        $this->assertSame($branchA->id, Student::query()->findOrFail($student->id)->originating_branch_id);

        // Rewriting provenance is rejected by the schema.
        try {
            $this->updateOriginatingBranch($student, $branchB->id);
            $this->fail('Rewriting originating_branch_id must be rejected by the schema.');
        } catch (QueryException $e) {
            $this->assertStringContainsString('originating_branch_id is immutable', $e->getMessage());
        }

        $this->assertSame($branchA->id, Student::query()->findOrFail($student->id)->originating_branch_id);
    }

    public function test_a_scope_link_cannot_self_link(): void
    {
        $branch = $this->makeBranch('f1-self-branch');
        $actor = $this->makeStudent()['person'];

        try {
            DB::table('branch_scope_links')->insert($this->linkRow($branch->id, $branch->id, $actor->id));
            $this->fail('A self-referential scope link must be rejected.');
        } catch (QueryException $e) {
            $this->assertStringContainsString('check', $e->getMessage());
        }

        $this->assertSame(0, DB::table('branch_scope_links')->count());
    }

    public function test_at_most_one_open_scope_link_per_owner_branch_and_close_then_open(): void
    {
        $owner = $this->makeBranch('f1-owner');
        $a = $this->makeBranch('f1-affected-a');
        $b = $this->makeBranch('f1-affected-b');
        $actor = $this->makeStudent()['person'];

        DB::table('branch_scope_links')->insert($this->linkRow($owner->id, $a->id, $actor->id));
        $this->assertSame(1, DB::table('branch_scope_links')->count());

        // A second OPEN link for the same owner is rejected.
        try {
            DB::table('branch_scope_links')->insert($this->linkRow($owner->id, $b->id, $actor->id));
            $this->fail('A second open scope link for one owner branch must be rejected.');
        } catch (QueryException $e) {
            $this->assertStringContainsString('branch_scope_links_one_open_owner', $e->getMessage());
        }

        // Closing the open link then opening a new one is the append-only path.
        DB::table('branch_scope_links')->where('owner_branch_id', $owner->id)
            ->where('lifecycle_state', 'active')
            ->update(['lifecycle_state' => 'closed', 'effective_to' => '2026-09-03']);
        DB::table('branch_scope_links')->insert($this->linkRow($owner->id, $b->id, $actor->id));

        $this->assertSame(2, DB::table('branch_scope_links')->count());
    }

    public function test_all_branch_originating_records_carry_provenance_and_home_branch_columns(): void
    {
        foreach ([
            'students', 'enrollments', 'obligations', 'certificates',
            'payments', 'refunds', 'fund_allocations', 'contracts',
        ] as $tableName) {
            $this->assertTrue(Schema::hasColumn($tableName, 'originating_branch_id'), "$tableName must carry originating_branch_id");
            $this->assertTrue(Schema::hasColumn($tableName, 'current_home_branch_id'), "$tableName must carry current_home_branch_id");
        }
    }

    public function test_every_new_provenance_anchor_has_an_immutability_guard(): void
    {
        foreach (['payments', 'refunds', 'fund_allocations', 'contracts'] as $tableName) {
            $guard = DB::selectOne(
                'SELECT 1 FROM pg_trigger WHERE tgname = ? AND NOT tgisinternal',
                [$tableName.'_originating_immutable'],
            );
            $this->assertNotNull($guard, "$tableName must have an originating_branch_id immutability trigger");
        }
    }

    public function test_scope_link_lifecycle_requires_the_open_window_invariant(): void
    {
        $owner = $this->makeBranch('f1-lifecycle-owner');
        $affected = $this->makeBranch('f1-lifecycle-affected');
        $actor = $this->makeStudent()['person'];

        // An OPEN/active link must have no effective_to (the one-active rule is
        // the single current authority) — a non-null end is a closed/historical link.
        try {
            $row = $this->linkRow($owner->id, $affected->id, $actor->id);
            $row['effective_to'] = '2026-09-03';
            DB::table('branch_scope_links')->insert($row);
            $this->fail('An active scope link must have a NULL effective_to.');
        } catch (QueryException $e) {
            $this->assertStringContainsString('branch_scope_links_open_window_check', $e->getMessage());
        }

        // A closed link is historical and must have its window end set.
        try {
            $row = $this->linkRow($owner->id, $affected->id, $actor->id);
            $row['lifecycle_state'] = 'closed';
            DB::table('branch_scope_links')->insert($row);
            $this->fail('A closed scope link must have a non-NULL effective_to.');
        } catch (QueryException $e) {
            $this->assertStringContainsString('branch_scope_links_open_window_check', $e->getMessage());
        }

        // A closed link must never invert its window.
        try {
            $row = $this->linkRow($owner->id, $affected->id, $actor->id);
            $row['lifecycle_state'] = 'closed';
            $row['effective_to'] = '2026-09-02';
            DB::table('branch_scope_links')->insert($row);
            $this->fail('A scope link window cannot be inverted.');
        } catch (QueryException $e) {
            $this->assertStringContainsString('branch_scope_links_window_check', $e->getMessage());
        }

        $this->assertSame(0, DB::table('branch_scope_links')->count());
    }

    private function makeBranch(string $suffix): Branch
    {
        return Branch::query()->create([
            'id' => RandomIdentifier::new(),
            'name' => 'Branch-'.$suffix.'-'.substr(md5((string) random_int(1, PHP_INT_MAX)), 0, 8),
            'lifecycle_state' => 'active',
        ]);
    }

    private function updateOriginatingBranch(Student $student, string $branchId): void
    {
        DB::table('students')->where('id', $student->id)
            ->update(['originating_branch_id' => $branchId]);
    }

    /** @return array<string, mixed> */
    private function linkRow(string $ownerId, string $affectedId, string $actorId): array
    {
        return [
            'id' => RandomIdentifier::new(),
            'owner_branch_id' => $ownerId,
            'affected_branch_id' => $affectedId,
            'effective_from' => '2026-09-03',
            'effective_to' => null,
            'lifecycle_state' => 'active',
            'created_by' => $actorId,
            'correlation_id' => RandomIdentifier::new(),
            'created_at' => now()->toDateTimeString(),
        ];
    }
}
