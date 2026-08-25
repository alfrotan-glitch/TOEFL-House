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
}
