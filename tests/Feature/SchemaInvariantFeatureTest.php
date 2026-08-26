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
        $this->assertContains('consents_one_open_per_subject_purpose', $this->indexNames('consents'));
        $this->assertContains('students_one_per_person', $this->indexNames('students'));
        $this->assertContains('guardian_relationships_one_open_per_pair', $this->indexNames('guardian_relationships'));
        $this->assertContains('enrollments_one_active_seat', $this->indexNames('enrollments'));
        $this->assertContains('teacher_assignments_one_open_per_class_teacher', $this->indexNames('teacher_assignments'));
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

    public function test_consent_lifecycle_states_are_constrained_by_the_schema(): void
    {
        $this->expectException(QueryException::class);
        DB::table('consents')->insert([
            'id' => '00000000-0000-4000-8000-00000000013a',
            'subject_person_id' => '00000000-0000-4000-8000-00000000013b',
            'purpose_id' => '00000000-0000-4000-8000-00000000013c',
            'lifecycle_state' => 'paused',
            'effective_from' => '2026-01-01',
            'effective_to' => null,
            'evidence_ref' => 'schema-guard',
            'recorded_by' => '00000000-0000-4000-8000-00000000013d',
        ]);
    }

    public function test_document_access_classes_are_constrained_by_the_schema(): void
    {
        $this->expectException(QueryException::class);
        DB::table('document_classifications')->insert([
            'id' => '00000000-0000-4000-8000-00000000014a',
            'category' => 'schema-guard-class',
            'owner_module' => 'Documents',
            'access_class' => 'top-secret',
        ]);
    }

    public function test_retention_actions_are_constrained_by_the_schema(): void
    {
        $this->expectException(QueryException::class);
        DB::table('retention_decisions')->insert([
            'id' => '00000000-0000-4000-8000-00000000015a',
            'document_id' => '00000000-0000-4000-8000-00000000015b',
            'rule_id' => '00000000-0000-4000-8000-00000000015c',
            'action' => 'shred',
            'basis' => 'schema-guard',
            'decided_by' => '00000000-0000-4000-8000-00000000015d',
        ]);
    }

    public function test_applicant_lifecycle_states_are_constrained_by_the_schema(): void
    {
        $this->expectException(QueryException::class);
        DB::table('applicants')->insert([
            'id' => '00000000-0000-4000-8000-00000000016a',
            'person_id' => '00000000-0000-4000-8000-00000000016b',
            'program_interest' => 'schema-guard',
            'lifecycle_state' => 'waitlisted',
            'recorded_by' => '00000000-0000-4000-8000-00000000016c',
        ]);
    }

    public function test_guardian_lifecycle_states_are_constrained_by_the_schema(): void
    {
        $this->expectException(QueryException::class);
        DB::table('guardian_relationships')->insert([
            'id' => '00000000-0000-4000-8000-00000000017a',
            'student_id' => '00000000-0000-4000-8000-00000000017b',
            'guardian_person_id' => '00000000-0000-4000-8000-00000000017c',
            'relationship' => 'schema-guard',
            'permissions' => '[]',
            'verification_state' => 'verified',
            'lifecycle_state' => 'paused',
            'effective_from' => '2026-01-01',
            'effective_to' => null,
            'recorded_by' => '00000000-0000-4000-8000-00000000017d',
        ]);
    }

    public function test_class_lifecycle_states_are_constrained_by_the_schema(): void
    {
        $this->expectException(QueryException::class);
        DB::table('programs')->insert([
            'id' => '00000000-0000-4000-8000-00000000018a',
            'name' => 'schema-guard-program',
            'lifecycle_state' => 'rumored',
        ]);
    }

    public function test_attendance_statuses_are_constrained_by_the_schema(): void
    {
        $this->expectException(QueryException::class);
        DB::table('attendance_facts')->insert([
            'id' => '00000000-0000-4000-8000-00000000019a',
            'session_id' => '00000000-0000-4000-8000-00000000019b',
            'enrollment_id' => '00000000-0000-4000-8000-00000000019c',
            'status' => 'maybe',
            'recorded_by' => '00000000-0000-4000-8000-00000000019d',
        ]);
    }
}
