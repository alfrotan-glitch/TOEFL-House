<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Schema;

return new class extends Migration
{
    public function up(): void
    {
        Schema::create('job_schedules', function (Blueprint $table): void {
            $table->char('id', 36)->primary();
            $table->string('job_key');
            $table->string('name');
            $table->string('schedule_expr');
            $table->boolean('enabled')->default(true);
            $table->char('created_by', 36);
            $table->timestamps();
        });
        DB::statement('CREATE UNIQUE INDEX job_schedules_key_unique ON job_schedules (job_key)');
        DB::statement(<<<'SQL'
            CREATE OR REPLACE FUNCTION job_schedules_history_retained() RETURNS trigger AS $fn$
            BEGIN
                IF TG_OP = 'DELETE' THEN
                    RAISE EXCEPTION 'job schedule history cannot be deleted';
                END IF;
                IF NEW.job_key <> OLD.job_key THEN
                    RAISE EXCEPTION 'a scheduled job keeps its key';
                END IF;
                RETURN NEW;
            END;
            $fn$ LANGUAGE plpgsql;
            SQL);
        DB::statement('CREATE TRIGGER job_schedules_history_retained_trigger BEFORE UPDATE OR DELETE ON job_schedules FOR EACH ROW EXECUTE FUNCTION job_schedules_history_retained()');
    }

    public function down(): void
    {
        DB::statement('DROP TRIGGER IF EXISTS job_schedules_history_retained_trigger ON job_schedules');
        DB::statement('DROP FUNCTION IF EXISTS job_schedules_history_retained()');
        Schema::dropIfExists('job_schedules');
    }
};
