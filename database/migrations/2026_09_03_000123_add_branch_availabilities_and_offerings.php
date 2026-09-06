<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Schema;

/**
 * WP-2 F3 (WP2-DEC-03): co-dependent BranchAvailability + Term + Offering.
 *
 * An Offering is the concrete packaging unit "branch B runs program-version
 * level L in academic period/term T". It exists only when an active
 * BranchAvailability declares exactly that (branch x level x term) combination,
 * and a period must be open. Existing enrollments keep a NULL offering_id (no
 * fabricated retro-offering); new enrollments may target an Offering (WP-3).
 *
 * Constraints (schema-level, mirroring the domain):
 *   - offering.unique(branch, level, period): one offering per triple.
 *   - branch_availability.unique(branch, level, period): one declaration per triple.
 *   - trigger: an offering requires a matching ACTIVE availability and an OPEN period.
 *   - offerings/availabilities reference real branches, levels, and periods (FK).
 */
return new class extends Migration
{
    public function up(): void
    {
        Schema::create('branch_availabilities', function (Blueprint $table): void {
            $table->char('id', 36)->primary();
            $table->char('branch_id', 36);
            $table->char('program_version_level_id', 36);
            $table->char('academic_period_id', 36);
            $table->string('lifecycle_state');
            $table->timestamps();
            $table->foreign('branch_id')->references('id')->on('branches');
            $table->foreign('program_version_level_id')->references('id')->on('program_version_levels');
            $table->foreign('academic_period_id')->references('id')->on('academic_periods');
            $table->unique(['branch_id', 'program_version_level_id', 'academic_period_id'], 'branch_availabilities_unique_triple');
        });

        Schema::create('offerings', function (Blueprint $table): void {
            $table->char('id', 36)->primary();
            $table->char('branch_id', 36);
            $table->char('program_version_level_id', 36);
            $table->char('academic_period_id', 36);
            $table->integer('capacity');
            $table->string('lifecycle_state');
            $table->timestamps();
            $table->foreign('branch_id')->references('id')->on('branches');
            $table->foreign('program_version_level_id')->references('id')->on('program_version_levels');
            $table->foreign('academic_period_id')->references('id')->on('academic_periods');
            $table->unique(['branch_id', 'program_version_level_id', 'academic_period_id'], 'offerings_unique_triple');
        });
        DB::statement('ALTER TABLE offerings ADD CONSTRAINT offerings_capacity_positive CHECK (capacity >= 1)');

        Schema::table('enrollments', function (Blueprint $table): void {
            $table->char('offering_id', 36)->nullable();
            $table->foreign('offering_id')->references('id')->on('offerings');
        });

        // An offering requires a matching ACTIVE availability and an OPEN term.
        DB::statement(<<<'SQL'
            CREATE OR REPLACE FUNCTION offering_requires_available_branch() RETURNS trigger AS $fn$
            DECLARE
                period_state text;
            BEGIN
                SELECT lifecycle_state INTO period_state
                  FROM academic_periods WHERE id = NEW.academic_period_id;
                IF period_state IS NULL OR period_state <> 'published' THEN
                    RAISE EXCEPTION 'offering term must be published/open'
                        USING ERRCODE = 'check_violation';
                END IF;
                IF NOT EXISTS (
                    SELECT 1 FROM branch_availabilities ba
                     WHERE ba.branch_id = NEW.branch_id
                       AND ba.program_version_level_id = NEW.program_version_level_id
                       AND ba.academic_period_id = NEW.academic_period_id
                       AND ba.lifecycle_state = 'active'
                ) THEN
                    RAISE EXCEPTION 'offering requires an active branch availability for the branch, level and term'
                        USING ERRCODE = 'check_violation';
                END IF;
                RETURN NEW;
            END;
            $fn$ LANGUAGE plpgsql
        SQL);
        DB::statement('CREATE TRIGGER offerings_availability_required BEFORE INSERT OR UPDATE ON offerings FOR EACH ROW EXECUTE FUNCTION offering_requires_available_branch()');
    }

    public function down(): void
    {
        DB::statement('DROP TRIGGER IF EXISTS offerings_availability_required ON offerings');
        DB::statement('DROP FUNCTION IF EXISTS offering_requires_available_branch()');

        Schema::table('enrollments', function (Blueprint $table): void {
            $table->dropForeign(['offering_id']);
            $table->dropColumn('offering_id');
        });
        Schema::dropIfExists('offerings');
        Schema::dropIfExists('branch_availabilities');
    }
};
