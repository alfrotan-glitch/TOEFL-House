<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Schema;

/**
 * A held calculation is not completed by arbitrary recalculation. A governed
 * Payroll resolution records the replacement prepared calculation and the
 * evidence/actor that made the predecessor terminal.
 */
return new class extends Migration
{
    public function up(): void
    {
        Schema::table('payroll_calculations', function (Blueprint $table): void {
            $table->text('resolution_ref')->nullable();
            $table->char('resolved_by', 36)->nullable();
            $table->char('replacement_calculation_id', 36)->nullable();
            $table->foreign('resolved_by')->references('id')->on('people');
            $table->foreign('replacement_calculation_id')->references('id')->on('payroll_calculations');
        });
        DB::statement('DROP INDEX IF EXISTS payroll_calculations_one_live_per_period_employment');
        // A held predecessor may coexist with the replacement prepared
        // calculation until Payroll explicitly resolves the predecessor.
        DB::statement("CREATE UNIQUE INDEX payroll_calculations_one_live_per_period_employment ON payroll_calculations (period_id, employment_id) WHERE lifecycle_state IN ('prepared','resulted')");
        DB::statement(<<<'SQL'
            CREATE OR REPLACE FUNCTION payroll_calculations_resolution_guard() RETURNS trigger AS $fn$
            BEGIN
                IF TG_OP = 'INSERT' THEN
                    IF NEW.resolution_ref IS NOT NULL OR NEW.resolved_by IS NOT NULL OR NEW.replacement_calculation_id IS NOT NULL THEN
                        RAISE EXCEPTION 'resolution evidence cannot be supplied when inserting a payroll calculation'
                            USING ERRCODE = 'check_violation';
                    END IF;
                    RETURN NEW;
                END IF;
                IF OLD.lifecycle_state = 'held' AND NEW.lifecycle_state = 'superseded' THEN
                    IF NULLIF(btrim(NEW.resolution_ref), '') IS NULL
                       OR NEW.resolved_by IS NULL
                       OR NEW.replacement_calculation_id IS NULL
                       OR NEW.replacement_calculation_id = NEW.id
                       OR NOT EXISTS (
                           SELECT 1
                             FROM payroll_calculations replacement
                            WHERE replacement.id = NEW.replacement_calculation_id
                              AND replacement.period_id = NEW.period_id
                              AND replacement.employment_id = NEW.employment_id
                              AND replacement.lifecycle_state IN ('prepared', 'resulted')
                       ) THEN
                        RAISE EXCEPTION 'held payroll calculations require an evidenced prepared/resulted replacement to resolve'
                            USING ERRCODE = 'check_violation';
                    END IF;
                END IF;
                IF (NEW.resolution_ref IS NOT NULL OR NEW.resolved_by IS NOT NULL OR NEW.replacement_calculation_id IS NOT NULL)
                   AND (OLD.lifecycle_state <> 'held' OR NEW.lifecycle_state <> 'superseded') THEN
                    RAISE EXCEPTION 'payroll resolution evidence is valid only for held-to-superseded resolution'
                        USING ERRCODE = 'check_violation';
                END IF;
                RETURN NEW;
            END;
            $fn$ LANGUAGE plpgsql;
            SQL);
        DB::statement('CREATE TRIGGER payroll_calculations_resolution_guard_trigger BEFORE INSERT OR UPDATE ON payroll_calculations FOR EACH ROW EXECUTE FUNCTION payroll_calculations_resolution_guard()');
    }

    public function down(): void
    {
        DB::statement(<<<'SQL'
            DO $rollback$
            BEGIN
                IF EXISTS (SELECT 1 FROM payroll_calculations WHERE resolution_ref IS NOT NULL OR resolved_by IS NOT NULL OR replacement_calculation_id IS NOT NULL) THEN
                    RAISE EXCEPTION 'cannot roll back governed held-calculation resolution evidence'
                        USING ERRCODE = 'check_violation';
                END IF;
                IF EXISTS (
                    SELECT period_id, employment_id
                      FROM payroll_calculations
                     WHERE lifecycle_state IN ('prepared', 'held', 'resulted')
                     GROUP BY period_id, employment_id
                    HAVING COUNT(*) > 1
                ) THEN
                    RAISE EXCEPTION 'cannot restore the one-live payroll calculation index while replacement and held history coexist'
                        USING ERRCODE = 'check_violation';
                END IF;
            END
            $rollback$
            SQL);
        DB::statement('DROP TRIGGER IF EXISTS payroll_calculations_resolution_guard_trigger ON payroll_calculations');
        DB::statement('DROP FUNCTION IF EXISTS payroll_calculations_resolution_guard()');
        DB::statement('DROP INDEX IF EXISTS payroll_calculations_one_live_per_period_employment');
        DB::statement('CREATE UNIQUE INDEX payroll_calculations_one_live_per_period_employment ON payroll_calculations (period_id, employment_id) WHERE lifecycle_state IN (\'prepared\', \'held\', \'resulted\')');
        Schema::table('payroll_calculations', function (Blueprint $table): void {
            $table->dropForeign(['resolved_by']);
            $table->dropForeign(['replacement_calculation_id']);
            $table->dropColumn(['resolution_ref', 'resolved_by', 'replacement_calculation_id']);
        });
    }
};
