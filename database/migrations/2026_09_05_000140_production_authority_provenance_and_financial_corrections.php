<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Schema;

/**
 * Production authority hardening:
 * - admission provenance is captured before a Student is born;
 * - new branch-homed anchors cannot be created without provenance;
 * - Finance owns append-only, staged source-linked corrections;
 * - journal reversals have an explicit one-to-one source link.
 *
 * Existing null-provenance rows are intentionally preserved. The insert guard
 * protects new truth without fabricating historical attribution.
 */
return new class extends Migration
{
    /** @var list<string> */
    private const PROVENANCE_TABLES = [
        'applicants', 'students', 'enrollments', 'obligations', 'payments', 'refunds', 'certificates', 'fund_allocations',
    ];

    public function up(): void
    {
        Schema::table('applicants', function (Blueprint $table): void {
            $table->char('originating_branch_id', 36)->nullable();
            $table->char('current_home_branch_id', 36)->nullable();
            $table->foreign('originating_branch_id')->references('id')->on('branches');
            $table->foreign('current_home_branch_id')->references('id')->on('branches');
        });

        Schema::table('journals', function (Blueprint $table): void {
            $table->char('reversal_of_id', 36)->nullable();
            $table->foreign('reversal_of_id')->references('id')->on('journals');
        });
        // Preserve old reversal rows produced before the explicit source link
        // existed. The old command already stored the original id in source_id.
        DB::statement("UPDATE journals SET reversal_of_id = source_id WHERE source_type = 'journal' AND source_id IS NOT NULL");
        DB::statement("ALTER TABLE journals ADD CONSTRAINT journals_reversal_source_check CHECK ((source_type = 'journal') = (reversal_of_id IS NOT NULL))");
        DB::statement('CREATE UNIQUE INDEX journals_one_reversal_per_source ON journals(reversal_of_id) WHERE reversal_of_id IS NOT NULL');
        DB::statement('CREATE TRIGGER applicants_originating_immutable BEFORE UPDATE OF originating_branch_id ON applicants FOR EACH ROW EXECUTE FUNCTION guard_originating_branch_immutable()');

        DB::statement(<<<'SQL'
            CREATE OR REPLACE FUNCTION journals_reversal_guard() RETURNS trigger AS $fn$
            BEGIN
                IF NEW.reversal_of_id IS NOT NULL THEN
                    IF NEW.source_type <> 'journal' OR NEW.source_id IS DISTINCT FROM NEW.reversal_of_id THEN
                        RAISE EXCEPTION 'journal reversal source linkage is inconsistent'
                            USING ERRCODE = 'check_violation';
                    END IF;
                    IF EXISTS (SELECT 1 FROM journals WHERE id = NEW.reversal_of_id AND reversal_of_id IS NOT NULL) THEN
                        RAISE EXCEPTION 'a journal reversal cannot reverse another reversal'
                            USING ERRCODE = 'check_violation';
                    END IF;
                END IF;
                RETURN NEW;
            END;
            $fn$ LANGUAGE plpgsql;
            SQL);
        DB::statement('CREATE TRIGGER journals_reversal_guard_trigger BEFORE INSERT OR UPDATE ON journals FOR EACH ROW EXECUTE FUNCTION journals_reversal_guard()');

        Schema::create('financial_corrections', function (Blueprint $table): void {
            $table->char('id', 36)->primary();
            $table->char('period_id', 36);
            $table->string('correction_type');
            $table->char('obligation_id', 36)->nullable();
            $table->char('payment_allocation_id', 36)->nullable();
            $table->char('fund_allocation_id', 36)->nullable();
            $table->decimal('amount', 14, 2);
            $table->string('direction');
            $table->string('reason');
            $table->string('lifecycle_state');
            $table->char('requested_by', 36);
            $table->char('approved_by', 36)->nullable();
            $table->timestamp('approved_at')->nullable();
            $table->timestamps();
            $table->foreign('period_id')->references('id')->on('financial_periods');
            $table->foreign('obligation_id')->references('id')->on('obligations');
            $table->foreign('payment_allocation_id')->references('id')->on('payment_allocations');
            $table->foreign('fund_allocation_id')->references('id')->on('fund_allocations');
        });
        DB::statement("ALTER TABLE financial_corrections ADD CONSTRAINT financial_corrections_type_check CHECK (correction_type IN ('obligation_adjustment','allocation_reversal','fund_allocation_reversal'))");
        DB::statement("ALTER TABLE financial_corrections ADD CONSTRAINT financial_corrections_direction_check CHECK (direction IN ('decrease','increase'))");
        DB::statement("ALTER TABLE financial_corrections ADD CONSTRAINT financial_corrections_state_check CHECK (lifecycle_state IN ('proposed','recorded'))");
        DB::statement('ALTER TABLE financial_corrections ADD CONSTRAINT financial_corrections_amount_check CHECK (amount > 0)');
        DB::statement("ALTER TABLE financial_corrections ADD CONSTRAINT financial_corrections_source_shape_check CHECK ((correction_type = 'obligation_adjustment' AND obligation_id IS NOT NULL AND payment_allocation_id IS NULL AND fund_allocation_id IS NULL) OR (correction_type = 'allocation_reversal' AND obligation_id IS NULL AND payment_allocation_id IS NOT NULL AND fund_allocation_id IS NULL) OR (correction_type = 'fund_allocation_reversal' AND obligation_id IS NULL AND payment_allocation_id IS NULL AND fund_allocation_id IS NOT NULL))");
        DB::statement("ALTER TABLE financial_corrections ADD CONSTRAINT financial_corrections_reason_check CHECK (reason <> '')");

        DB::statement(<<<'SQL'
            CREATE OR REPLACE FUNCTION financial_corrections_guard() RETURNS trigger AS $fn$
            DECLARE
                source_amount numeric;
                source_period char(36);
                prior_amount numeric;
            BEGIN
                IF TG_OP = 'DELETE' THEN
                    RAISE EXCEPTION 'financial corrections are immutable facts and cannot be deleted'
                        USING ERRCODE = 'check_violation';
                END IF;
                IF TG_OP = 'INSERT' AND NEW.lifecycle_state <> 'proposed' THEN
                    RAISE EXCEPTION 'a financial correction is born proposed and requires an independent approval'
                        USING ERRCODE = 'check_violation';
                END IF;
                IF NOT EXISTS (SELECT 1 FROM financial_periods WHERE id = NEW.period_id AND lifecycle_state = 'open') THEN
                    RAISE EXCEPTION 'financial corrections require an open financial period'
                        USING ERRCODE = 'check_violation';
                END IF;
                IF TG_OP = 'UPDATE' THEN
                    IF OLD.lifecycle_state = 'recorded' THEN
                        RAISE EXCEPTION 'recorded financial corrections are immutable'
                            USING ERRCODE = 'check_violation';
                    END IF;
                    IF OLD.correction_type IS DISTINCT FROM NEW.correction_type
                       OR OLD.obligation_id IS DISTINCT FROM NEW.obligation_id
                       OR OLD.payment_allocation_id IS DISTINCT FROM NEW.payment_allocation_id
                       OR OLD.fund_allocation_id IS DISTINCT FROM NEW.fund_allocation_id
                       OR OLD.amount IS DISTINCT FROM NEW.amount
                       OR OLD.direction IS DISTINCT FROM NEW.direction
                       OR OLD.period_id IS DISTINCT FROM NEW.period_id
                       OR OLD.reason IS DISTINCT FROM NEW.reason
                       OR OLD.requested_by IS DISTINCT FROM NEW.requested_by THEN
                        RAISE EXCEPTION 'financial correction source and terms are immutable; approve the proposal or create a new fact'
                            USING ERRCODE = 'check_violation';
                    END IF;
                    IF OLD.lifecycle_state <> 'proposed' OR NEW.lifecycle_state <> 'recorded' THEN
                        RAISE EXCEPTION 'a financial correction may transition only proposed -> recorded'
                            USING ERRCODE = 'check_violation';
                    END IF;
                    IF NEW.approved_by IS NULL OR NEW.approved_at IS NULL OR trim(NEW.approved_by) = trim(NEW.requested_by) THEN
                        RAISE EXCEPTION 'a financial correction requires an independent approval identity and timestamp'
                            USING ERRCODE = 'check_violation';
                    END IF;
                END IF;

                IF NEW.correction_type = 'obligation_adjustment' THEN
                    SELECT original_amount, period_id INTO source_amount, source_period
                      FROM obligations WHERE id = NEW.obligation_id FOR UPDATE;
                    IF source_amount IS NULL THEN
                        RAISE EXCEPTION 'financial correction references an unknown obligation'
                            USING ERRCODE = 'foreign_key_violation';
                    END IF;
                    IF NEW.period_id <> source_period OR NEW.amount > source_amount THEN
                        RAISE EXCEPTION 'obligation correction must use the source financial period and cannot exceed the source charge'
                            USING ERRCODE = 'check_violation';
                    END IF;
                    SELECT COALESCE(SUM(amount), 0) INTO prior_amount
                      FROM financial_corrections
                     WHERE obligation_id = NEW.obligation_id
                       AND correction_type = 'obligation_adjustment'
                       AND direction = NEW.direction
                       AND lifecycle_state = 'recorded';
                    IF prior_amount + NEW.amount > source_amount THEN
                        RAISE EXCEPTION 'obligation corrections cannot exceed the source charge'
                            USING ERRCODE = 'check_violation';
                    END IF;
                ELSIF NEW.correction_type = 'allocation_reversal' THEN
                    SELECT pa.amount, o.period_id INTO source_amount, source_period
                      FROM payment_allocations pa
                      JOIN obligations o ON o.id = pa.obligation_id
                     WHERE pa.id = NEW.payment_allocation_id FOR UPDATE;
                    IF source_amount IS NULL THEN
                        RAISE EXCEPTION 'allocation reversal references an unknown allocation'
                            USING ERRCODE = 'foreign_key_violation';
                    END IF;
                    IF NEW.direction <> 'decrease' OR NEW.period_id <> source_period THEN
                        RAISE EXCEPTION 'allocation reversals must decrease the source in its financial period'
                            USING ERRCODE = 'check_violation';
                    END IF;
                    SELECT COALESCE(SUM(amount), 0) INTO prior_amount
                      FROM financial_corrections
                     WHERE payment_allocation_id = NEW.payment_allocation_id
                       AND correction_type = 'allocation_reversal'
                       AND lifecycle_state = 'recorded';
                    IF prior_amount + NEW.amount > source_amount THEN
                        RAISE EXCEPTION 'allocation reversals cannot exceed the source allocation'
                            USING ERRCODE = 'check_violation';
                    END IF;
                ELSE
                    SELECT fa.amount, o.period_id INTO source_amount, source_period
                      FROM fund_allocations fa
                      JOIN obligation_lines ol ON ol.id = fa.obligation_line_id
                      JOIN obligations o ON o.id = ol.obligation_id
                     WHERE fa.id = NEW.fund_allocation_id FOR UPDATE;
                    IF source_amount IS NULL THEN
                        RAISE EXCEPTION 'fund allocation reversal references an unknown allocation'
                            USING ERRCODE = 'foreign_key_violation';
                    END IF;
                    IF NEW.direction <> 'decrease' OR NEW.period_id <> source_period THEN
                        RAISE EXCEPTION 'fund allocation reversals must decrease the source in its financial period'
                            USING ERRCODE = 'check_violation';
                    END IF;
                    SELECT COALESCE(SUM(amount), 0) INTO prior_amount
                      FROM financial_corrections
                     WHERE fund_allocation_id = NEW.fund_allocation_id
                       AND correction_type = 'fund_allocation_reversal'
                       AND lifecycle_state = 'recorded';
                    IF prior_amount + NEW.amount > source_amount THEN
                        RAISE EXCEPTION 'fund allocation reversals cannot exceed the source allocation'
                            USING ERRCODE = 'check_violation';
                    END IF;
                END IF;
                RETURN NEW;
            END;
            $fn$ LANGUAGE plpgsql;
            SQL);
        DB::statement('CREATE TRIGGER financial_corrections_guard_trigger BEFORE INSERT OR UPDATE OR DELETE ON financial_corrections FOR EACH ROW EXECUTE FUNCTION financial_corrections_guard()');

        DB::statement(<<<'SQL'
            CREATE OR REPLACE FUNCTION require_new_branch_provenance() RETURNS trigger AS $fn$
            BEGIN
                IF NEW.originating_branch_id IS NULL
                   OR NOT EXISTS (SELECT 1 FROM branches WHERE id = NEW.originating_branch_id AND lifecycle_state = 'active') THEN
                    RAISE EXCEPTION '% requires an existing active originating branch provenance for new records', TG_TABLE_NAME
                        USING ERRCODE = 'check_violation';
                END IF;
                IF NEW.current_home_branch_id IS NOT NULL
                   AND NOT EXISTS (SELECT 1 FROM branches WHERE id = NEW.current_home_branch_id AND lifecycle_state = 'active') THEN
                    RAISE EXCEPTION '% requires an existing active current-home branch provenance for new records', TG_TABLE_NAME
                        USING ERRCODE = 'check_violation';
                END IF;
                IF TG_TABLE_NAME = 'students' AND NEW.current_home_branch_id IS NULL THEN
                    RAISE EXCEPTION 'students require current home branch provenance for new records'
                        USING ERRCODE = 'check_violation';
                END IF;
                RETURN NEW;
            END;
            $fn$ LANGUAGE plpgsql;
            SQL);
        foreach (self::PROVENANCE_TABLES as $tableName) {
            DB::statement(sprintf(
                'CREATE TRIGGER %1$s_require_provenance BEFORE INSERT ON %1$s FOR EACH ROW EXECUTE FUNCTION require_new_branch_provenance()',
                $tableName,
            ));
        }
    }

    public function down(): void
    {
        DB::statement('DROP TRIGGER IF EXISTS applicants_originating_immutable ON applicants');
        foreach (self::PROVENANCE_TABLES as $tableName) {
            DB::statement(sprintf('DROP TRIGGER IF EXISTS %1$s_require_provenance ON %1$s', $tableName));
        }
        DB::statement('DROP FUNCTION IF EXISTS require_new_branch_provenance()');
        DB::statement('DROP TRIGGER IF EXISTS financial_corrections_guard_trigger ON financial_corrections');
        DB::statement('DROP FUNCTION IF EXISTS financial_corrections_guard()');
        Schema::dropIfExists('financial_corrections');
        DB::statement('DROP TRIGGER IF EXISTS journals_reversal_guard_trigger ON journals');
        DB::statement('DROP FUNCTION IF EXISTS journals_reversal_guard()');
        DB::statement('DROP INDEX IF EXISTS journals_one_reversal_per_source');
        DB::statement('ALTER TABLE journals DROP CONSTRAINT IF EXISTS journals_reversal_source_check');
        Schema::table('journals', function (Blueprint $table): void {
            $table->dropForeign(['reversal_of_id']);
            $table->dropColumn('reversal_of_id');
        });
        Schema::table('applicants', function (Blueprint $table): void {
            $table->dropForeign(['current_home_branch_id']);
            $table->dropForeign(['originating_branch_id']);
            $table->dropColumn(['current_home_branch_id', 'originating_branch_id']);
        });
    }
};
