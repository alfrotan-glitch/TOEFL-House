<?php

declare(strict_types=1);

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Schema;

/**
 * Append-only correction path for enrollment-gate coverage sources.
 *
 * Approved credits, installment plans, and gate exceptions are immutable
 * evidence. A recorded revocation does not rewrite the source or its original
 * commitment history; it removes the source from future gate assessments so a
 * separately evidenced replacement can be approved against released capacity.
 */
return new class extends Migration
{
    public function up(): void
    {
        Schema::create('financial_coverage_revocations', function (Blueprint $table): void {
            $table->char('id', 36)->primary();
            $table->string('coverage_source_type');
            $table->char('coverage_source_id', 36);
            $table->char('student_id', 36);
            $table->text('reason');
            $table->string('lifecycle_state');
            $table->char('requested_by', 36);
            $table->char('approved_by', 36)->nullable();
            $table->timestamp('approved_at')->nullable();
            $table->timestamps();

            $table->foreign('student_id')->references('id')->on('students');
        });
        DB::statement("ALTER TABLE financial_coverage_revocations ADD CONSTRAINT financial_coverage_revocations_type_check CHECK (coverage_source_type IN ('financial_credit', 'enrollment_installment_plan', 'financial_gate_exception'))");
        DB::statement("ALTER TABLE financial_coverage_revocations ADD CONSTRAINT financial_coverage_revocations_state_check CHECK (lifecycle_state IN ('proposed', 'recorded'))");
        DB::statement("ALTER TABLE financial_coverage_revocations ADD CONSTRAINT financial_coverage_revocations_reason_check CHECK (btrim(reason) <> '')");
        DB::statement("CREATE UNIQUE INDEX financial_coverage_revocation_one_recorded_source ON financial_coverage_revocations (coverage_source_type, coverage_source_id) WHERE lifecycle_state = 'recorded'");
        DB::statement('CREATE INDEX financial_coverage_revocation_source_index ON financial_coverage_revocations (coverage_source_type, coverage_source_id)');
        DB::statement('CREATE INDEX financial_coverage_revocation_student_index ON financial_coverage_revocations (student_id, lifecycle_state)');

        // Extend the commitment guard's active-source predicate only after
        // this table exists. A recorded revocation releases capacity for a
        // separately approved replacement without deleting history.
        DB::statement(<<<'SQL'
            CREATE OR REPLACE FUNCTION financial_coverage_source_is_active(source_type text, source_id text, as_of date) RETURNS boolean AS $fn$
            BEGIN
                IF EXISTS (
                    SELECT 1 FROM financial_coverage_revocations r
                     WHERE r.coverage_source_type = source_type
                       AND r.coverage_source_id = source_id
                       AND r.lifecycle_state = 'recorded'
                ) THEN
                    RETURN FALSE;
                END IF;
                IF source_type = 'financial_credit' THEN
                    RETURN EXISTS (
                        SELECT 1 FROM financial_credits
                         WHERE id = source_id AND lifecycle_state = 'approved'
                    );
                ELSIF source_type = 'enrollment_installment_plan' THEN
                    RETURN EXISTS (
                        SELECT 1 FROM enrollment_installment_plans
                         WHERE id = source_id AND lifecycle_state = 'approved'
                    );
                ELSIF source_type = 'financial_gate_exception' THEN
                    RETURN EXISTS (
                        SELECT 1 FROM financial_gate_exceptions
                         WHERE id = source_id
                           AND lifecycle_state = 'approved'
                           AND effective_from <= as_of
                           AND (effective_to IS NULL OR effective_to >= as_of)
                    );
                END IF;

                RETURN FALSE;
            END;
            $fn$ LANGUAGE plpgsql STABLE;
            SQL);

        DB::statement(<<<'SQL'
            CREATE OR REPLACE FUNCTION financial_coverage_revocations_guard() RETURNS trigger AS $fn$
            DECLARE
                source_student char(36);
            BEGIN
                IF TG_OP = 'DELETE' THEN
                    RAISE EXCEPTION 'financial coverage revocations are immutable correction history'
                        USING ERRCODE = 'check_violation';
                END IF;

                IF NEW.coverage_source_type = 'financial_credit' THEN
                    SELECT student_id INTO source_student
                      FROM financial_credits
                     WHERE id = NEW.coverage_source_id
                       AND lifecycle_state = 'approved'
                     FOR UPDATE;
                ELSIF NEW.coverage_source_type = 'enrollment_installment_plan' THEN
                    SELECT student_id INTO source_student
                      FROM enrollment_installment_plans
                     WHERE id = NEW.coverage_source_id
                       AND lifecycle_state = 'approved'
                     FOR UPDATE;
                ELSIF NEW.coverage_source_type = 'financial_gate_exception' THEN
                    SELECT student_id INTO source_student
                      FROM financial_gate_exceptions
                     WHERE id = NEW.coverage_source_id
                       AND lifecycle_state = 'approved'
                     FOR UPDATE;
                ELSE
                    RAISE EXCEPTION 'coverage revocation source type is unsupported'
                        USING ERRCODE = 'check_violation';
                END IF;
                IF source_student IS NULL OR NEW.student_id IS DISTINCT FROM source_student THEN
                    RAISE EXCEPTION 'coverage revocation must preserve the approved source student identity'
                        USING ERRCODE = 'check_violation';
                END IF;

                IF TG_OP = 'INSERT' THEN
                    IF NEW.lifecycle_state <> 'proposed'
                       OR NEW.approved_by IS NOT NULL
                       OR NEW.approved_at IS NOT NULL
                       OR btrim(NEW.requested_by) = '' THEN
                        RAISE EXCEPTION 'a financial coverage revocation is born proposed'
                            USING ERRCODE = 'check_violation';
                    END IF;
                    RETURN NEW;
                END IF;

                IF OLD.lifecycle_state <> 'proposed'
                   OR NEW.lifecycle_state <> 'recorded'
                   OR OLD.coverage_source_type IS DISTINCT FROM NEW.coverage_source_type
                   OR OLD.coverage_source_id IS DISTINCT FROM NEW.coverage_source_id
                   OR OLD.student_id IS DISTINCT FROM NEW.student_id
                   OR OLD.reason IS DISTINCT FROM NEW.reason
                   OR OLD.requested_by IS DISTINCT FROM NEW.requested_by
                   OR NEW.approved_by IS NULL
                   OR NEW.approved_at IS NULL
                   OR btrim(NEW.requested_by) = ''
                   OR btrim(NEW.approved_by) = ''
                   OR btrim(NEW.approved_by) = btrim(NEW.requested_by) THEN
                    RAISE EXCEPTION 'a coverage revocation may transition only proposed to recorded with immutable terms and an independent approver'
                        USING ERRCODE = 'check_violation';
                END IF;

                RETURN NEW;
            END;
            $fn$ LANGUAGE plpgsql;
            SQL);
        DB::statement('CREATE TRIGGER financial_coverage_revocations_guard_trigger BEFORE INSERT OR UPDATE OR DELETE ON financial_coverage_revocations FOR EACH ROW EXECUTE FUNCTION financial_coverage_revocations_guard()');
    }

    public function down(): void
    {
        DB::statement('DROP TRIGGER IF EXISTS financial_coverage_revocations_guard_trigger ON financial_coverage_revocations');
        DB::statement('DROP FUNCTION IF EXISTS financial_coverage_revocations_guard()');
        DB::statement(<<<'SQL'
            CREATE OR REPLACE FUNCTION financial_coverage_source_is_active(source_type text, source_id text, as_of date) RETURNS boolean AS $fn$
            BEGIN
                IF source_type = 'financial_credit' THEN
                    RETURN EXISTS (
                        SELECT 1 FROM financial_credits
                         WHERE id = source_id AND lifecycle_state = 'approved'
                    );
                ELSIF source_type = 'enrollment_installment_plan' THEN
                    RETURN EXISTS (
                        SELECT 1 FROM enrollment_installment_plans
                         WHERE id = source_id AND lifecycle_state = 'approved'
                    );
                ELSIF source_type = 'financial_gate_exception' THEN
                    RETURN EXISTS (
                        SELECT 1 FROM financial_gate_exceptions
                         WHERE id = source_id
                           AND lifecycle_state = 'approved'
                           AND effective_from <= as_of
                           AND (effective_to IS NULL OR effective_to >= as_of)
                    );
                END IF;

                RETURN FALSE;
            END;
            $fn$ LANGUAGE plpgsql STABLE;
            SQL);
        Schema::dropIfExists('financial_coverage_revocations');
    }
};
