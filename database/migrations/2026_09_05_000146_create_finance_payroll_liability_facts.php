<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Schema;

/**
 * Finance recognition of approved Payroll source evidence. Payroll calculates
 * and corrects its evidence; Finance alone recognizes signed monetary facts
 * used by reporting and downstream settlement/disbursement.
 */
return new class extends Migration
{
    public function up(): void
    {
        // Capture Payroll's branch provenance at approval time. Finance must
        // never reconstruct a historical source branch from today's mutable
        // person designation.
        Schema::table('payroll_results', function (Blueprint $table): void {
            $table->char('originating_branch_id', 36)->nullable();
            $table->foreign('originating_branch_id')->references('id')->on('branches');
        });
        DB::statement(<<<'SQL'
            CREATE OR REPLACE FUNCTION payroll_results_originating_branch_guard() RETURNS trigger AS $fn$
            DECLARE
                employee_branch char(36);
            BEGIN
                SELECT p.home_branch_id INTO employee_branch
                  FROM employments e
                  JOIN people p ON p.id = e.person_id
                 WHERE e.id = NEW.employment_id;
                IF NEW.originating_branch_id IS NULL
                   OR employee_branch IS NULL
                   OR NEW.originating_branch_id IS DISTINCT FROM employee_branch
                   OR NOT EXISTS (SELECT 1 FROM branches WHERE id = NEW.originating_branch_id AND lifecycle_state = 'active') THEN
                    RAISE EXCEPTION 'an approved Payroll result requires an active originating branch snapshot matching the employee home branch'
                        USING ERRCODE = 'check_violation';
                END IF;
                RETURN NEW;
            END;
            $fn$ LANGUAGE plpgsql;
            SQL);
        DB::statement('CREATE TRIGGER payroll_results_originating_branch_guard_trigger BEFORE INSERT OR UPDATE ON payroll_results FOR EACH ROW EXECUTE FUNCTION payroll_results_originating_branch_guard()');

        Schema::create('payroll_liability_facts', function (Blueprint $table): void {
            $table->char('id', 36)->primary();
            $table->string('source_type');
            $table->char('source_id', 36);
            $table->char('period_id', 36);
            $table->char('employment_id', 36);
            $table->char('originating_branch_id', 36);
            $table->decimal('amount', 14, 2);
            $table->char('recognized_by', 36);
            $table->string('correlation_id');
            $table->string('evidence_ref');
            $table->timestamps();
            $table->foreign('period_id')->references('id')->on('payroll_periods');
            $table->foreign('employment_id')->references('id')->on('employments');
            $table->foreign('originating_branch_id')->references('id')->on('branches');
            $table->foreign('recognized_by')->references('id')->on('people');
        });
        DB::statement("ALTER TABLE payroll_liability_facts ADD CONSTRAINT payroll_liability_source_check CHECK (source_type IN ('payroll_result','payroll_adjustment'))");
        DB::statement("ALTER TABLE payroll_liability_facts ADD CONSTRAINT payroll_liability_amount_check CHECK (amount <> 0)");
        DB::statement("ALTER TABLE payroll_liability_facts ADD CONSTRAINT payroll_liability_evidence_check CHECK (evidence_ref <> '' AND correlation_id <> '')");
        DB::statement('CREATE UNIQUE INDEX payroll_liability_one_recognition_per_source ON payroll_liability_facts (source_type, source_id)');
        DB::statement(<<<'SQL'
            CREATE OR REPLACE FUNCTION payroll_liability_source_guard() RETURNS trigger AS $fn$
            DECLARE
                source_amount numeric;
                source_period char(36);
                source_employment char(36);
                source_approver char(36);
                source_branch char(36);
            BEGIN
                IF NEW.source_type = 'payroll_result' THEN
                    SELECT amount, period_id, employment_id, approved_by, originating_branch_id
                      INTO source_amount, source_period, source_employment, source_approver, source_branch
                      FROM payroll_results
                     WHERE id = NEW.source_id AND lifecycle_state = 'approved';
                ELSE
                    SELECT pa.amount, pr.period_id, pr.employment_id, pa.approved_by, pr.originating_branch_id
                      INTO source_amount, source_period, source_employment, source_approver, source_branch
                      FROM payroll_adjustments pa
                      JOIN payroll_results pr ON pr.id = pa.result_id AND pr.lifecycle_state = 'approved'
                     WHERE pa.id = NEW.source_id;
                END IF;
                IF source_amount IS NULL THEN
                    RAISE EXCEPTION 'Finance liability source must be an existing approved Payroll fact'
                        USING ERRCODE = 'foreign_key_violation';
                END IF;
                IF NEW.amount IS DISTINCT FROM source_amount
                   OR NEW.period_id IS DISTINCT FROM source_period
                   OR NEW.employment_id IS DISTINCT FROM source_employment THEN
                    RAISE EXCEPTION 'Finance liability must preserve the exact Payroll source identity and amount'
                        USING ERRCODE = 'check_violation';
                END IF;
                IF source_approver IS NULL OR trim(NEW.recognized_by) = trim(source_approver) THEN
                    RAISE EXCEPTION 'Finance liability recognition requires an independent Finance actor'
                        USING ERRCODE = 'check_violation';
                END IF;
                IF source_branch IS NULL OR NEW.originating_branch_id IS DISTINCT FROM source_branch
                   OR NOT EXISTS (SELECT 1 FROM branches b WHERE b.id = source_branch AND b.lifecycle_state = 'active') THEN
                    RAISE EXCEPTION 'Finance liability recognition requires matching active employee branch provenance'
                        USING ERRCODE = 'check_violation';
                END IF;
                RETURN NEW;
            END;
            $fn$ LANGUAGE plpgsql;
            SQL);
        DB::statement('CREATE TRIGGER payroll_liability_source_guard_trigger BEFORE INSERT ON payroll_liability_facts FOR EACH ROW EXECUTE FUNCTION payroll_liability_source_guard()');
        DB::statement(<<<'SQL'
            CREATE OR REPLACE FUNCTION payroll_liability_facts_append_only() RETURNS trigger AS $fn$
            BEGIN
                RAISE EXCEPTION 'Finance payroll liability facts are immutable; corrections append source-linked facts';
            END;
            $fn$ LANGUAGE plpgsql;
            SQL);
        DB::statement('CREATE TRIGGER payroll_liability_facts_append_only_trigger BEFORE UPDATE OR DELETE ON payroll_liability_facts FOR EACH ROW EXECUTE FUNCTION payroll_liability_facts_append_only()');
    }

    public function down(): void
    {
        DB::statement('DROP TRIGGER IF EXISTS payroll_results_originating_branch_guard_trigger ON payroll_results');
        DB::statement('DROP FUNCTION IF EXISTS payroll_results_originating_branch_guard()');
        DB::statement('DROP TRIGGER IF EXISTS payroll_liability_source_guard_trigger ON payroll_liability_facts');
        DB::statement('DROP FUNCTION IF EXISTS payroll_liability_source_guard()');
        DB::statement('DROP TRIGGER IF EXISTS payroll_liability_facts_append_only_trigger ON payroll_liability_facts');
        DB::statement('DROP FUNCTION IF EXISTS payroll_liability_facts_append_only()');
        Schema::dropIfExists('payroll_liability_facts');
        Schema::table('payroll_results', function (Blueprint $table): void {
            $table->dropForeign(['originating_branch_id']);
            $table->dropColumn('originating_branch_id');
        });
    }
};
