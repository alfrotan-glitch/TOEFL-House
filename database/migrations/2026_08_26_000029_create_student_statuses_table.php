<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Schema;

return new class extends Migration
{
    public function up(): void
    {
        Schema::create('student_statuses', function (Blueprint $table): void {
            $table->bigIncrements('seq');
            $table->char('id', 36)->primary();
            $table->char('student_id', 36);
            $table->string('status');
            $table->date('effective_from');
            $table->string('reason');
            $table->char('actor_id', 36);
            $table->timestamps();
            $table->foreign('student_id')->references('id')->on('students');
        });
        DB::statement("ALTER TABLE student_statuses ADD CONSTRAINT student_statuses_status_check CHECK (status IN ('active','suspended','withdrawn','completed','alumni'))");
        DB::statement(<<<'SQL'
            CREATE OR REPLACE FUNCTION student_statuses_append_only() RETURNS trigger AS $fn$
            BEGIN
                RAISE EXCEPTION 'student status history is append-only; the current status is the latest row, corrections append';
            END;
            $fn$ LANGUAGE plpgsql;
            SQL);
        DB::statement('CREATE TRIGGER student_statuses_append_only_trigger BEFORE UPDATE OR DELETE ON student_statuses FOR EACH ROW EXECUTE FUNCTION student_statuses_append_only()');
    }

    public function down(): void
    {
        DB::statement('DROP TRIGGER IF EXISTS student_statuses_append_only_trigger ON student_statuses');
        DB::statement('DROP FUNCTION IF EXISTS student_statuses_append_only()');
        Schema::dropIfExists('student_statuses');
    }
};
