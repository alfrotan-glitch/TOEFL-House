<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Schema;

/**
 * P16 finalization — hard retirement of the legacy work-basis volume
 * evidence. Teaching volume is derived exclusively from authoritative
 * academic delivery evidence (skill-attributed sessions with qualifying
 * attendance) and claimed once per session by payroll; the manual and
 * academic-sourced work basis path that fed the retired per-kind
 * compensation calculation is removed from the active system. No
 * historical business data exists to preserve (P02-P15 certified
 * baseline, no production data).
 */
return new class extends Migration
{
    public function up(): void
    {
        DB::statement('DROP TRIGGER IF EXISTS work_bases_append_only_trigger ON work_bases');
        DB::statement('DROP FUNCTION IF EXISTS work_bases_append_only()');
        Schema::dropIfExists('work_bases');
    }

    public function down(): void
    {
        Schema::create('work_bases', function (Blueprint $table): void {
            $table->char('id', 36)->primary();
            $table->char('employment_id', 36);
            $table->string('source');
            $table->char('teacher_assignment_id', 36)->nullable();
            $table->date('period_from');
            $table->date('period_to');
            $table->decimal('quantity', 10, 2);
            $table->string('unit');
            $table->string('evidence_ref');
            $table->text('note')->nullable();
            $table->string('lifecycle_state');
            $table->char('recorded_by', 36);
            $table->timestamps();
            $table->foreign('employment_id')->references('id')->on('employments');
            $table->foreign('teacher_assignment_id')->references('id')->on('teacher_assignments');
        });
        DB::statement("ALTER TABLE work_bases ADD CONSTRAINT work_bases_source_check CHECK (source IN ('academic','manual'))");
        DB::statement("ALTER TABLE work_bases ADD CONSTRAINT work_bases_unit_check CHECK (unit IN ('hours','classes'))");
        DB::statement("ALTER TABLE work_bases ADD CONSTRAINT work_bases_lifecycle_state_check CHECK (lifecycle_state IN ('recorded','held'))");
        DB::statement('ALTER TABLE work_bases ADD CONSTRAINT work_bases_period_check CHECK (period_to >= period_from)');
        DB::statement('ALTER TABLE work_bases ADD CONSTRAINT work_bases_quantity_check CHECK (quantity > 0)');
        DB::statement(<<<'SQL'
            CREATE OR REPLACE FUNCTION work_bases_append_only() RETURNS trigger AS $fn$
            BEGIN
                RAISE EXCEPTION 'work basis evidence is retained source history and cannot be rewritten or deleted';
            END;
            $fn$ LANGUAGE plpgsql;
            SQL);
        DB::statement('CREATE TRIGGER work_bases_append_only_trigger BEFORE UPDATE OR DELETE ON work_bases FOR EACH ROW EXECUTE FUNCTION work_bases_append_only()');
    }
};
