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
        $this->assertContains('assessment_results_one_live_per_attempt', $this->indexNames('assessment_results'));
        $this->assertContains('progression_decisions_one_open_per_student_class', $this->indexNames('progression_decisions'));
        $this->assertContains('graduation_decisions_one_open_per_student_version', $this->indexNames('graduation_decisions'));
        $this->assertContains('certificates_serial_unique', $this->indexNames('certificates'));
        $this->assertContains('employments_one_open_per_person', $this->indexNames('employments'));
        $this->assertContains('contracts_one_open_per_employment', $this->indexNames('contracts'));
        $this->assertContains('leaves_one_pending_per_employment', $this->indexNames('leaves'));
        $this->assertContains('payroll_periods_key_unique', $this->indexNames('payroll_periods'));
        $this->assertContains('payroll_calculations_one_live_per_period_employment', $this->indexNames('payroll_calculations'));
        $this->assertContains('payroll_results_one_per_calculation', $this->indexNames('payroll_results'));
        $this->assertContains('payroll_clearances_one_per_domain', $this->indexNames('payroll_clearances'));
        $this->assertContains('accounts_code_unique', $this->indexNames('accounts'));
        $this->assertContains('financial_periods_key_unique', $this->indexNames('financial_periods'));
        $this->assertContains('reconciliations_one_per_period_subject', $this->indexNames('reconciliations'));
        $this->assertContains('payments_payer_ref_unique', $this->indexNames('payments'));
        $this->assertContains('payment_allocations_one_per_pair', $this->indexNames('payment_allocations'));
        $this->assertContains('assets_code_unique', $this->indexNames('assets'));
        $this->assertContains('custodies_one_open_per_asset', $this->indexNames('custodies'));
        $this->assertContains('asset_disposals_one_per_asset', $this->indexNames('asset_disposals'));
        $this->assertContains('book_copies_code_unique', $this->indexNames('book_copies'));
        $this->assertContains('book_issuances_one_open_per_copy', $this->indexNames('book_issuances'));
        $this->assertContains('metric_definitions_key_unique', $this->indexNames('metric_definitions'));
        $this->assertContains('metric_versions_one_per_no', $this->indexNames('metric_versions'));
        $this->assertContains('metric_projections_one_slice', $this->indexNames('metric_projections'));
        $this->assertContains('dashboards_name_unique', $this->indexNames('dashboards'));
        $this->assertContains('dashboard_pins_one_per_slice', $this->indexNames('dashboard_pins'));
    }

    public function test_reporting_metric_shape_is_constrained_by_the_schema(): void
    {
        $this->expectException(QueryException::class);
        DB::table('metric_definitions')->insert([
            'id' => '00000000-0000-4000-8000-00000000030a',
            'key' => 'probe.metric',
            'name' => 'Probe',
            'source_owner' => 'marketing',
            'period_authority' => 'financial_period',
            'current_version' => 1,
            'defined_by' => '00000000-0000-4000-8000-00000000030b',
        ]);
    }

    public function test_reporting_period_authority_is_constrained_by_the_schema(): void
    {
        $this->expectException(QueryException::class);
        DB::table('metric_definitions')->insert([
            'id' => '00000000-0000-4000-8000-00000000031a',
            'key' => 'probe.metric',
            'name' => 'Probe',
            'source_owner' => 'finance',
            'period_authority' => 'lunar_month',
            'current_version' => 1,
            'defined_by' => '00000000-0000-4000-8000-00000000031b',
        ]);
    }

    public function test_reporting_projection_completeness_is_constrained_by_the_schema(): void
    {
        $this->expectException(QueryException::class);
        DB::table('metric_projections')->insert([
            'id' => '00000000-0000-4000-8000-00000000032a',
            'metric_version_id' => '00000000-0000-4000-8000-00000000032b',
            'period_key' => '2026-12',
            'scope_type' => 'global',
            'scope_id' => null,
            'value' => '1.00',
            'completeness' => 'approximate',
            'computed_by' => '00000000-0000-4000-8000-00000000032c',
        ]);
    }

    public function test_reporting_reconciliation_variance_identity_is_constrained_by_the_schema(): void
    {
        $this->expectException(QueryException::class);
        DB::table('metric_reconciliations')->insert([
            'id' => '00000000-0000-4000-8000-00000000033a',
            'metric_id' => '00000000-0000-4000-8000-00000000033b',
            'period_key' => '2026-12',
            'scope_type' => 'global',
            'scope_id' => null,
            'reported_value' => '10.00',
            'authoritative_value' => '8.00',
            'variance' => '1.00',
            'status' => 'diverged',
            'reconciled_by' => '00000000-0000-4000-8000-00000000033c',
        ]);
    }

    public function test_reporting_immutability_triggers_exist(): void
    {
        $versionTriggers = DB::table('pg_trigger')->join('pg_class', 'pg_class.oid', '=', 'pg_trigger.tgrelid')->where('pg_class.relname', 'metric_versions')->pluck('tgname')->all();
        $this->assertContains('metric_versions_immutable_trigger', $versionTriggers, 'metric versions must be immutable at the schema level');

        $projectionTriggers = DB::table('pg_trigger')->join('pg_class', 'pg_class.oid', '=', 'pg_trigger.tgrelid')->where('pg_class.relname', 'metric_projections')->pluck('tgname')->all();
        $this->assertContains('metric_projections_rebuild_only_trigger', $projectionTriggers, 'projections may only be rebuilt in place, never re-keyed');

        $runTriggers = DB::table('pg_trigger')->join('pg_class', 'pg_class.oid', '=', 'pg_trigger.tgrelid')->where('pg_class.relname', 'report_runs')->pluck('tgname')->all();
        $this->assertContains('report_runs_immutable_trigger', $runTriggers, 'report runs must be immutable at the schema level');

        $reconciliationTriggers = DB::table('pg_trigger')->join('pg_class', 'pg_class.oid', '=', 'pg_trigger.tgrelid')->where('pg_class.relname', 'metric_reconciliations')->pluck('tgname')->all();
        $this->assertContains('metric_reconciliations_immutable_trigger', $reconciliationTriggers, 'reconciliation evidence must be immutable at the schema level');

        $pinTriggers = DB::table('pg_trigger')->join('pg_class', 'pg_class.oid', '=', 'pg_trigger.tgrelid')->where('pg_class.relname', 'dashboard_pins')->pluck('tgname')->all();
        $this->assertContains('dashboard_pins_immutable_trigger', $pinTriggers, 'dashboard pins must be immutable at the schema level');
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

    public function test_assessment_attempts_kind_and_state_are_constrained_by_the_schema(): void
    {
        $this->expectException(QueryException::class);
        DB::table('assessment_attempts')->insert([
            'id' => '00000000-0000-4000-8000-00000000020a',
            'enrollment_id' => '00000000-0000-4000-8000-00000000020b',
            'kind' => 'crystal-ball',
            'evidence_ref' => 'probe/ref',
            'lifecycle_state' => 'submitted',
            'recorded_by' => '00000000-0000-4000-8000-00000000020c',
        ]);
    }

    public function test_assessment_result_states_and_scores_are_constrained_by_the_schema(): void
    {
        $this->expectException(QueryException::class);
        DB::table('assessment_results')->insert([
            'id' => '00000000-0000-4000-8000-00000000021a',
            'attempt_id' => '00000000-0000-4000-8000-00000000021b',
            'score' => -1,
            'lifecycle_state' => 'final',
            'scored_by' => '00000000-0000-4000-8000-00000000021c',
        ]);
    }

    public function test_academic_appeal_subjects_are_constrained_by_the_schema(): void
    {
        $this->expectException(QueryException::class);
        DB::table('academic_appeals')->insert([
            'id' => '00000000-0000-4000-8000-00000000022a',
            'student_id' => '00000000-0000-4000-8000-00000000022b',
            'subject_type' => 'vibe',
            'subject_id' => '00000000-0000-4000-8000-00000000022c',
            'reason' => 'schema probe',
            'lifecycle_state' => 'open',
        ]);
    }

    public function test_progression_and_graduation_outcomes_are_constrained_by_the_schema(): void
    {
        $this->expectException(QueryException::class);
        DB::table('progression_decisions')->insert([
            'id' => '00000000-0000-4000-8000-00000000023a',
            'student_id' => '00000000-0000-4000-8000-00000000023b',
            'class_id' => '00000000-0000-4000-8000-00000000023c',
            'outcome' => 'teleport',
            'reason' => 'schema probe',
            'lifecycle_state' => 'proposed',
            'proposed_by' => '00000000-0000-4000-8000-00000000023d',
        ]);
    }

    public function test_graduation_outcomes_are_constrained_by_the_schema(): void
    {
        $this->expectException(QueryException::class);
        DB::table('graduation_decisions')->insert([
            'id' => '00000000-0000-4000-8000-00000000024a',
            'student_id' => '00000000-0000-4000-8000-00000000024b',
            'program_version_id' => '00000000-0000-4000-8000-00000000024c',
            'outcome' => 'maybe',
            'basis' => 'schema probe',
            'lifecycle_state' => 'proposed',
            'proposed_by' => '00000000-0000-4000-8000-00000000024d',
        ]);
    }

    public function test_employment_states_are_constrained_by_the_schema(): void
    {
        $this->expectException(QueryException::class);
        DB::table('employments')->insert([
            'id' => '00000000-0000-4000-8000-00000000026a',
            'person_id' => '00000000-0000-4000-8000-00000000026b',
            'lifecycle_state' => 'vanished',
        ]);
    }

    public function test_contract_states_are_constrained_by_the_schema(): void
    {
        $this->expectException(QueryException::class);
        DB::table('contracts')->insert([
            'id' => '00000000-0000-4000-8000-00000000027a',
            'employment_id' => '00000000-0000-4000-8000-00000000027b',
            'terms_summary' => 'schema probe',
            'lifecycle_state' => 'whispered',
            'effective_from' => '2026-01-01',
        ]);
    }

    public function test_work_basis_sources_and_leave_states_are_constrained_by_the_schema(): void
    {
        $this->expectException(QueryException::class);
        DB::table('work_bases')->insert([
            'id' => '00000000-0000-4000-8000-00000000028a',
            'employment_id' => '00000000-0000-4000-8000-00000000028b',
            'source' => 'rumor',
            'period_from' => '2026-01-01',
            'period_to' => '2026-01-31',
            'quantity' => 10,
            'unit' => 'hours',
            'evidence_ref' => 'probe/ref',
            'lifecycle_state' => 'recorded',
            'recorded_by' => '00000000-0000-4000-8000-00000000028c',
        ]);
    }

    public function test_payroll_states_are_constrained_by_the_schema(): void
    {
        $this->expectException(QueryException::class);
        DB::table('payroll_calculations')->insert([
            'id' => '00000000-0000-4000-8000-00000000029a',
            'period_id' => '00000000-0000-4000-8000-00000000029b',
            'employment_id' => '00000000-0000-4000-8000-00000000029c',
            'base_amount' => 100,
            'snapshot' => '{}',
            'lifecycle_state' => 'guessed',
            'prepared_by' => '00000000-0000-4000-8000-00000000029d',
        ]);
    }

    public function test_payroll_adjustment_kinds_are_constrained_by_the_schema(): void
    {
        $this->expectException(QueryException::class);
        DB::table('payroll_adjustments')->insert([
            'id' => '00000000-0000-4000-8000-00000000030a',
            'result_id' => '00000000-0000-4000-8000-00000000030b',
            'kind' => 'nudge',
            'amount' => 5,
            'reason' => 'schema probe',
            'approved_by' => '00000000-0000-4000-8000-00000000030c',
        ]);
    }

    public function test_account_types_are_constrained_by_the_schema(): void
    {
        $this->expectException(QueryException::class);
        DB::table('accounts')->insert([
            'id' => '00000000-0000-4000-8000-00000000031a',
            'code' => '9999',
            'name' => 'schema probe',
            'type' => 'profit',
        ]);
    }

    public function test_journal_directions_are_constrained_by_the_schema(): void
    {
        $this->expectException(QueryException::class);
        DB::table('journal_lines')->insert([
            'id' => '00000000-0000-4000-8000-00000000032a',
            'journal_id' => '00000000-0000-4000-8000-00000000032b',
            'account_id' => '00000000-0000-4000-8000-00000000032c',
            'direction' => 'maybe',
            'amount' => 5,
        ]);
    }

    public function test_reconciliation_variance_is_constrained_by_the_schema(): void
    {
        $this->expectException(QueryException::class);
        DB::table('reconciliations')->insert([
            'id' => '00000000-0000-4000-8000-00000000033a',
            'period_id' => '00000000-0000-4000-8000-00000000033b',
            'subject' => 'schema-probe',
            'expected' => 100,
            'observed' => 90,
            'variance' => 0,
            'lifecycle_state' => 'draft',
            'observed_by' => '00000000-0000-4000-8000-00000000033c',
        ]);
    }

    public function test_payment_amounts_are_constrained_by_the_schema(): void
    {
        $this->expectException(QueryException::class);
        DB::table('payments')->insert([
            'id' => '00000000-0000-4000-8000-00000000034a',
            'period_id' => '00000000-0000-4000-8000-00000000034b',
            'student_id' => '00000000-0000-4000-8000-00000000034c',
            'amount' => -5,
            'method' => 'cash',
            'payer_ref' => 'SCHEMA-PROBE-34',
            'received_on' => '2026-11-01',
            'recorded_by' => '00000000-0000-4000-8000-00000000034d',
        ]);
    }

    public function test_discount_states_are_constrained_by_the_schema(): void
    {
        $this->expectException(QueryException::class);
        DB::table('discounts')->insert([
            'id' => '00000000-0000-4000-8000-00000000035a',
            'obligation_id' => '00000000-0000-4000-8000-00000000035b',
            'period_id' => '00000000-0000-4000-8000-00000000035c',
            'amount' => 100,
            'eligibility' => 'schema probe',
            'effective_from' => '2026-11-01',
            'reason' => 'probe',
            'lifecycle_state' => 'whispered',
            'proposed_by' => '00000000-0000-4000-8000-00000000035d',
        ]);
    }

    public function test_work_order_states_are_constrained_by_the_schema(): void
    {
        $this->expectException(QueryException::class);
        DB::table('work_orders')->insert([
            'id' => '00000000-0000-4000-8000-00000000036a',
            'facility_note' => 'probe',
            'description' => 'probe',
            'lifecycle_state' => 'daydreaming',
            'requested_by' => '00000000-0000-4000-8000-00000000036b',
        ]);
    }

    public function test_message_states_are_constrained_by_the_schema(): void
    {
        $this->expectException(QueryException::class);
        DB::table('messages')->insert([
            'id' => '00000000-0000-4000-8000-00000000037a',
            'subject_person_id' => '00000000-0000-4000-8000-00000000037b',
            'purpose_id' => '00000000-0000-4000-8000-00000000037c',
            'channel' => 'sms',
            'content_ref' => 'probe/x',
            'lifecycle_state' => 'telepathized',
            'created_by' => '00000000-0000-4000-8000-00000000037d',
        ]);
    }

    public function test_append_only_triggers_exist_in_the_schema(): void
    {
        $certificateTriggers = DB::table('pg_trigger')->join('pg_class', 'pg_class.oid', '=', 'pg_trigger.tgrelid')->where('pg_class.relname', 'certificates')->pluck('tgname')->all();
        $this->assertContains('certificates_immutable_trigger', $certificateTriggers, 'certificate issuance records must be immutable at the schema level');

        $attemptTriggers = DB::table('pg_trigger')->join('pg_class', 'pg_class.oid', '=', 'pg_trigger.tgrelid')->where('pg_class.relname', 'assessment_attempts')->pluck('tgname')->all();
        $this->assertContains('assessment_attempts_submitted_immutable_trigger', $attemptTriggers, 'submitted attempts must be frozen at the schema level');

        $employmentStatusTriggers = DB::table('pg_trigger')->join('pg_class', 'pg_class.oid', '=', 'pg_trigger.tgrelid')->where('pg_class.relname', 'employment_statuses')->pluck('tgname')->all();
        $this->assertContains('employment_statuses_append_only_trigger', $employmentStatusTriggers, 'employment status history must be append-only at the schema level');

        $workBasisTriggers = DB::table('pg_trigger')->join('pg_class', 'pg_class.oid', '=', 'pg_trigger.tgrelid')->where('pg_class.relname', 'work_bases')->pluck('tgname')->all();
        $this->assertContains('work_bases_append_only_trigger', $workBasisTriggers, 'work basis evidence must be retained at the schema level');

        $contractTriggers = DB::table('pg_trigger')->join('pg_class', 'pg_class.oid', '=', 'pg_trigger.tgrelid')->where('pg_class.relname', 'contracts')->pluck('tgname')->all();
        $this->assertContains('contracts_signed_terms_immutable_trigger', $contractTriggers, 'signed contract terms must be immutable at the schema level');
        $this->assertContains('contracts_no_delete_trigger', $contractTriggers, 'contracts must never be deleted');

        $compensationTriggers = DB::table('pg_trigger')->join('pg_class', 'pg_class.oid', '=', 'pg_trigger.tgrelid')->where('pg_class.relname', 'compensation_components')->pluck('tgname')->all();
        $this->assertContains('compensation_components_active_immutable_trigger', $compensationTriggers, 'active compensation components must be immutable at the schema level');

        $payrollPeriodTriggers = DB::table('pg_trigger')->join('pg_class', 'pg_class.oid', '=', 'pg_trigger.tgrelid')->where('pg_class.relname', 'payroll_periods')->pluck('tgname')->all();
        $this->assertContains('payroll_periods_closed_immutable_trigger', $payrollPeriodTriggers, 'closed payroll periods must be immutable at the schema level');

        $payrollResultTriggers = DB::table('pg_trigger')->join('pg_class', 'pg_class.oid', '=', 'pg_trigger.tgrelid')->where('pg_class.relname', 'payroll_results')->pluck('tgname')->all();
        $this->assertContains('payroll_results_immutable_trigger', $payrollResultTriggers, 'approved payroll results must be immutable at the schema level');

        $payrollAdjustmentTriggers = DB::table('pg_trigger')->join('pg_class', 'pg_class.oid', '=', 'pg_trigger.tgrelid')->where('pg_class.relname', 'payroll_adjustments')->pluck('tgname')->all();
        $this->assertContains('payroll_adjustments_append_only_trigger', $payrollAdjustmentTriggers, 'payroll adjustments must be append-only at the schema level');

        $settlementTriggers = DB::table('pg_trigger')->join('pg_class', 'pg_class.oid', '=', 'pg_trigger.tgrelid')->where('pg_class.relname', 'final_settlements')->pluck('tgname')->all();
        $this->assertContains('final_settlements_immutable_trigger', $settlementTriggers, 'final settlements must be immutable at the schema level');

        $accountTriggers = DB::table('pg_trigger')->join('pg_class', 'pg_class.oid', '=', 'pg_trigger.tgrelid')->where('pg_class.relname', 'accounts')->pluck('tgname')->all();
        $this->assertContains('accounts_immutable_trigger', $accountTriggers, 'chart-of-accounts entries must be immutable at the schema level');

        $financialPeriodTriggers = DB::table('pg_trigger')->join('pg_class', 'pg_class.oid', '=', 'pg_trigger.tgrelid')->where('pg_class.relname', 'financial_periods')->pluck('tgname')->all();
        $this->assertContains('financial_periods_closed_immutable_trigger', $financialPeriodTriggers, 'closed financial periods must be immutable at the schema level');

        $journalTriggers = DB::table('pg_trigger')->join('pg_class', 'pg_class.oid', '=', 'pg_trigger.tgrelid')->where('pg_class.relname', 'journals')->pluck('tgname')->all();
        $this->assertContains('journals_immutable_trigger', $journalTriggers, 'posted journals must be immutable at the schema level');

        $obligationTriggers = DB::table('pg_trigger')->join('pg_class', 'pg_class.oid', '=', 'pg_trigger.tgrelid')->where('pg_class.relname', 'obligations')->pluck('tgname')->all();
        $this->assertContains('obligations_immutable_trigger', $obligationTriggers, 'posted obligations must be immutable at the schema level');

        $paymentTriggers = DB::table('pg_trigger')->join('pg_class', 'pg_class.oid', '=', 'pg_trigger.tgrelid')->where('pg_class.relname', 'payments')->pluck('tgname')->all();
        $this->assertContains('payments_immutable_trigger', $paymentTriggers, 'posted payments must be immutable at the schema level');

        $allocationTriggers = DB::table('pg_trigger')->join('pg_class', 'pg_class.oid', '=', 'pg_trigger.tgrelid')->where('pg_class.relname', 'payment_allocations')->pluck('tgname')->all();
        $this->assertContains('payment_allocations_immutable_trigger', $allocationTriggers, 'payment allocations must be immutable at the schema level');

        $refundTriggers = DB::table('pg_trigger')->join('pg_class', 'pg_class.oid', '=', 'pg_trigger.tgrelid')->where('pg_class.relname', 'refunds')->pluck('tgname')->all();
        $this->assertContains('refunds_immutable_trigger', $refundTriggers, 'refunds must be immutable at the schema level');

        $discountTriggers = DB::table('pg_trigger')->join('pg_class', 'pg_class.oid', '=', 'pg_trigger.tgrelid')->where('pg_class.relname', 'discounts')->pluck('tgname')->all();
        $this->assertContains('discounts_approved_immutable_trigger', $discountTriggers, 'approved discounts must be immutable at the schema level');

        $fundTriggers = DB::table('pg_trigger')->join('pg_class', 'pg_class.oid', '=', 'pg_trigger.tgrelid')->where('pg_class.relname', 'funding_sources')->pluck('tgname')->all();
        $this->assertContains('funding_sources_immutable_trigger', $fundTriggers, 'funding agreements must be immutable at the schema level');

        $fundAllocationTriggers = DB::table('pg_trigger')->join('pg_class', 'pg_class.oid', '=', 'pg_trigger.tgrelid')->where('pg_class.relname', 'fund_allocations')->pluck('tgname')->all();
        $this->assertContains('fund_allocations_immutable_trigger', $fundAllocationTriggers, 'fund allocations must be immutable at the schema level');

        $assetTriggers = DB::table('pg_trigger')->join('pg_class', 'pg_class.oid', '=', 'pg_trigger.tgrelid')->where('pg_class.relname', 'assets')->pluck('tgname')->all();
        $this->assertContains('assets_disposed_immutable_trigger', $assetTriggers, 'disposed assets must be immutable at the schema level');

        $custodyTriggers = DB::table('pg_trigger')->join('pg_class', 'pg_class.oid', '=', 'pg_trigger.tgrelid')->where('pg_class.relname', 'custodies')->pluck('tgname')->all();
        $this->assertContains('custodies_release_only_trigger', $custodyTriggers, 'custody rows may only be released, never rewritten');
        $this->assertContains('custodies_no_delete_trigger', $custodyTriggers, 'custody history cannot be deleted');

        $disposalTriggers = DB::table('pg_trigger')->join('pg_class', 'pg_class.oid', '=', 'pg_trigger.tgrelid')->where('pg_class.relname', 'asset_disposals')->pluck('tgname')->all();
        $this->assertContains('asset_disposals_immutable_trigger', $disposalTriggers, 'asset disposals must be immutable at the schema level');

        $workOrderTriggers = DB::table('pg_trigger')->join('pg_class', 'pg_class.oid', '=', 'pg_trigger.tgrelid')->where('pg_class.relname', 'work_orders')->pluck('tgname')->all();
        $this->assertContains('work_orders_terminal_immutable_trigger', $workOrderTriggers, 'terminal work orders must be immutable at the schema level');

        $issuanceTriggers = DB::table('pg_trigger')->join('pg_class', 'pg_class.oid', '=', 'pg_trigger.tgrelid')->where('pg_class.relname', 'book_issuances')->pluck('tgname')->all();
        $this->assertContains('book_issuances_terminal_immutable_trigger', $issuanceTriggers, 'terminal book issuances must be immutable at the schema level');

        $messageTriggers = DB::table('pg_trigger')->join('pg_class', 'pg_class.oid', '=', 'pg_trigger.tgrelid')->where('pg_class.relname', 'messages')->pluck('tgname')->all();
        $this->assertContains('messages_terminal_immutable_trigger', $messageTriggers, 'delivered messages must be immutable at the schema level');
    }
}
