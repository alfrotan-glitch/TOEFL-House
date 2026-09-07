<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Schema;

/**
 * A report run is immutable audit evidence, but it previously retained only a
 * number. Calculators can now truthfully return an incomplete result when a
 * historical source clock/provenance is unresolved. Preserve old runs with a
 * null classification instead of rewriting them, and require every new run
 * to retain its evidence completeness and explanatory calculation metadata.
 */
return new class extends Migration
{
    public function up(): void
    {
        Schema::table('report_runs', function (Blueprint $table): void {
            $table->string('completeness')->nullable();
            $table->jsonb('meta')->nullable();
        });
        DB::statement(<<<'SQL'
            ALTER TABLE report_runs
                ADD CONSTRAINT report_runs_completeness_check
                CHECK (completeness IS NULL OR completeness IN ('complete', 'incomplete')) NOT VALID
            SQL);
        DB::statement(<<<'SQL'
            CREATE OR REPLACE FUNCTION report_runs_completeness_guard() RETURNS trigger AS $fn$
            BEGIN
                -- SQL three-valued logic makes `NULL NOT IN (...)` unknown,
                -- not true. Legacy rows may retain a null classification, but
                -- every *new* immutable report run must state it explicitly.
                IF NEW.completeness IS NULL
                   OR NEW.completeness NOT IN ('complete', 'incomplete')
                   OR NEW.meta IS NULL
                   OR jsonb_typeof(NEW.meta) IS DISTINCT FROM 'object' THEN
                    RAISE EXCEPTION 'new report runs require complete-or-incomplete source evidence and calculation metadata'
                        USING ERRCODE = 'check_violation';
                END IF;
                RETURN NEW;
            END;
            $fn$ LANGUAGE plpgsql;
            SQL);
        DB::statement('DROP TRIGGER IF EXISTS report_runs_completeness_guard_trigger ON report_runs');
        DB::statement('CREATE TRIGGER report_runs_completeness_guard_trigger BEFORE INSERT ON report_runs FOR EACH ROW EXECUTE FUNCTION report_runs_completeness_guard()');
    }

    public function down(): void
    {
        // Removing the classification would turn retained incomplete report
        // evidence back into an apparently ordinary numeric report.
        throw new \RuntimeException('Report-run evidence completeness is one-way; do not erase retained source provenance.');
    }
};
