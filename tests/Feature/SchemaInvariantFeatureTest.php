<?php

declare(strict_types=1);

namespace Tests\Feature;

use Illuminate\Database\QueryException;
use Illuminate\Support\Facades\DB;
use Tests\TestCase;

/**
 * Migration and schema validation gate: the structural constraints that
 * guard the invariants exist in the database, independent of the
 * application layer.
 */
final class SchemaInvariantFeatureTest extends TestCase
{
    /** @return list<string> */
    private function indexNames(string $table): array
    {
        return DB::table('pg_indexes')->where('tablename', $table)->pluck('indexname')->all();
    }

    public function test_partial_unique_indexes_protect_the_core_invariants(): void
    {
        $this->assertContains('campus_assignments_one_open_per_branch', $this->indexNames('campus_assignments'));
        $this->assertContains('people_single_verified_identity', $this->indexNames('people'));
        $this->assertContains('user_accounts_one_active_per_person', $this->indexNames('user_accounts'));
        $this->assertContains('position_assignments_one_open_per_person_position', $this->indexNames('position_assignments'));
        $this->assertContains('scope_grants_one_open_grant', $this->indexNames('scope_grants'));
        $this->assertContains('access_policies_one_open_position_role', $this->indexNames('access_policies'));
        $this->assertContains('delegations_one_open_authority', $this->indexNames('delegations'));
    }

    public function test_lifecycle_states_are_constrained_by_the_schema(): void
    {
        $this->expectException(QueryException::class);
        DB::table('organizations')->insert([
            'id' => '00000000-0000-4000-8000-00000000000a',
            'name' => 'Invalid State Organization',
            'lifecycle_state' => 'archived',
        ]);
    }

    public function test_account_state_is_constrained_by_the_schema(): void
    {
        $this->expectException(QueryException::class);
        DB::table('user_accounts')->insert([
            'id' => '00000000-0000-4000-8000-00000000000b',
            'person_id' => '00000000-0000-4000-8000-00000000000c',
            'username' => 'schema.probe',
            'account_state' => 'dormant',
        ]);
    }

    public function test_access_lifecycle_states_are_constrained_by_the_schema(): void
    {
        $this->expectException(QueryException::class);
        DB::table('scope_grants')->insert([
            'id' => '00000000-0000-4000-8000-00000000010a',
            'person_id' => '00000000-0000-4000-8000-00000000010b',
            'permission' => 'identity.verify',
            'scope_type' => 'organization',
            'scope_id' => '00000000-0000-4000-8000-00000000010c',
            'lifecycle_state' => 'suspended',
            'effective_from' => '2026-01-01',
            'effective_to' => null,
            'is_emergency' => false,
            'review_required' => false,
            'granted_by' => '00000000-0000-4000-8000-00000000010d',
        ]);
    }

    public function test_access_scope_types_are_constrained_by_the_schema(): void
    {
        $this->expectException(QueryException::class);
        DB::table('scope_grants')->insert([
            'id' => '00000000-0000-4000-8000-00000000011a',
            'person_id' => '00000000-0000-4000-8000-00000000011b',
            'permission' => 'identity.verify',
            'scope_type' => 'galaxy',
            'scope_id' => '00000000-0000-4000-8000-00000000011c',
            'lifecycle_state' => 'active',
            'effective_from' => '2026-01-01',
            'effective_to' => null,
            'is_emergency' => false,
            'review_required' => false,
            'granted_by' => '00000000-0000-4000-8000-00000000011d',
        ]);
    }

    public function test_delegation_period_and_self_delegation_are_constrained_by_the_schema(): void
    {
        $this->expectException(QueryException::class);
        DB::table('delegations')->insert([
            'id' => '00000000-0000-4000-8000-00000000012a',
            'delegator_person_id' => '00000000-0000-4000-8000-00000000012b',
            'delegate_person_id' => '00000000-0000-4000-8000-00000000012b',
            'permission' => null,
            'scope_type' => null,
            'scope_id' => null,
            'lifecycle_state' => 'active',
            'effective_from' => '2026-01-01',
            'effective_to' => '2026-02-01',
            'reason' => 'schema guard',
            'created_by' => '00000000-0000-4000-8000-00000000012c',
        ]);
    }
}
