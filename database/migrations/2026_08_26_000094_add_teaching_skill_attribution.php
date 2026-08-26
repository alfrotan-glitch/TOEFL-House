<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Schema;

return new class extends Migration
{
    public function up(): void
    {
        Schema::table('class_sessions', function (Blueprint $table): void {
            $table->char('skill_id', 36)->nullable()->after('class_id');
            $table->foreign('skill_id')->references('id')->on('skills');
        });
        DB::statement(<<<'SQL'
            CREATE OR REPLACE FUNCTION class_sessions_skill_delivery_guard() RETURNS trigger AS $fn$
            DECLARE skill_state text;
            BEGIN
                IF NEW.skill_id IS NULL THEN
                    RETURN NEW;
                END IF;
                SELECT lifecycle_state INTO skill_state FROM skills WHERE id = NEW.skill_id;
                IF skill_state IS DISTINCT FROM 'active' THEN
                    RAISE EXCEPTION 'a session delivers an active skill; retired or unknown skills cannot be scheduled';
                END IF;
                RETURN NEW;
            END;
            $fn$ LANGUAGE plpgsql;
            SQL);
        DB::statement('CREATE TRIGGER class_sessions_skill_delivery_guard_trigger BEFORE INSERT OR UPDATE ON class_sessions FOR EACH ROW EXECUTE FUNCTION class_sessions_skill_delivery_guard()');

        Schema::create('teacher_assignment_skills', function (Blueprint $table): void {
            $table->char('id', 36)->primary();
            $table->char('teacher_assignment_id', 36);
            $table->char('skill_id', 36);
            $table->timestamps();
            $table->foreign('teacher_assignment_id')->references('id')->on('teacher_assignments');
            $table->foreign('skill_id')->references('id')->on('skills');
        });
        DB::statement('CREATE UNIQUE INDEX teacher_assignment_skills_one_per_assignment_skill ON teacher_assignment_skills (teacher_assignment_id, skill_id)');
        DB::statement(<<<'SQL'
            CREATE OR REPLACE FUNCTION teacher_assignment_skills_append_only() RETURNS trigger AS $fn$
            BEGIN
                RAISE EXCEPTION 'teaching assignment skills are append-only evidence; reassign with a new effective-dated assignment instead';
            END;
            $fn$ LANGUAGE plpgsql;
            SQL);
        DB::statement('CREATE TRIGGER teacher_assignment_skills_append_only_trigger BEFORE UPDATE OR DELETE ON teacher_assignment_skills FOR EACH ROW EXECUTE FUNCTION teacher_assignment_skills_append_only()');
    }

    public function down(): void
    {
        DB::statement('DROP TRIGGER IF EXISTS teacher_assignment_skills_append_only_trigger ON teacher_assignment_skills');
        DB::statement('DROP FUNCTION IF EXISTS teacher_assignment_skills_append_only()');
        DB::statement('DROP TRIGGER IF EXISTS class_sessions_skill_delivery_guard_trigger ON class_sessions');
        DB::statement('DROP FUNCTION IF EXISTS class_sessions_skill_delivery_guard()');
        Schema::dropIfExists('teacher_assignment_skills');
        Schema::table('class_sessions', function (Blueprint $table): void {
            $table->dropForeign(['skill_id']);
            $table->dropColumn('skill_id');
        });
    }
};
