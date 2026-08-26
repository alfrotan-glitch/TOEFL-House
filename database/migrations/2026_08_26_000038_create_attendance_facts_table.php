<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Schema;

return new class extends Migration
{
    public function up(): void
    {
        Schema::create('attendance_facts', function (Blueprint $table): void {
            $table->char('id', 36)->primary();
            $table->char('session_id', 36);
            $table->char('enrollment_id', 36);
            $table->string('status');
            $table->char('corrects_id', 36)->nullable();
            $table->string('reason')->nullable();
            $table->char('recorded_by', 36);
            $table->timestamps();
            $table->foreign('session_id')->references('id')->on('class_sessions');
            $table->foreign('enrollment_id')->references('id')->on('enrollments');
        });
        DB::statement("ALTER TABLE attendance_facts ADD CONSTRAINT attendance_facts_status_check CHECK (status IN ('present','absent','late','excused'))");
        DB::statement(<<<'SQL'
            CREATE OR REPLACE FUNCTION attendance_facts_append_only() RETURNS trigger AS $fn$
            BEGIN
                RAISE EXCEPTION 'attendance history is append-only; corrections append a linked correction row';
            END;
            $fn$ LANGUAGE plpgsql;
            SQL);
        DB::statement('CREATE TRIGGER attendance_facts_append_only_trigger BEFORE UPDATE OR DELETE ON attendance_facts FOR EACH ROW EXECUTE FUNCTION attendance_facts_append_only()');
    }

    public function down(): void
    {
        DB::statement('DROP TRIGGER IF EXISTS attendance_facts_append_only_trigger ON attendance_facts');
        DB::statement('DROP FUNCTION IF EXISTS attendance_facts_append_only()');
        Schema::dropIfExists('attendance_facts');
    }
};
