<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Schema;

return new class extends Migration
{
    public function up(): void
    {
        Schema::create('job_runs', function (Blueprint $table): void {
            $table->char('id', 36)->primary();
            $table->string('job_key');
            $table->string('run_key');
            $table->string('status');
            $table->integer('attempts')->default(0);
            $table->integer('max_attempts');
            $table->char('run_by', 36);
            $table->string('last_error')->nullable();
            $table->jsonb('outcome')->nullable();
            $table->timestampTz('next_retry_at')->nullable();
            $table->timestampTz('started_at')->nullable();
            $table->timestampTz('finished_at')->nullable();
            $table->timestamps();
        });
        DB::statement("ALTER TABLE job_runs ADD CONSTRAINT job_runs_status_check CHECK (status IN ('queued','failed','succeeded','dead_letter'))");
        DB::statement('ALTER TABLE job_runs ADD CONSTRAINT job_runs_attempts_check CHECK (attempts >= 0 AND max_attempts BETWEEN 1 AND 10)');
        DB::statement('CREATE UNIQUE INDEX job_runs_one_per_occurrence ON job_runs (job_key, run_key)');
        DB::statement(<<<'SQL'
            CREATE OR REPLACE FUNCTION job_runs_identity_retained() RETURNS trigger AS $fn$
            BEGIN
                IF TG_OP = 'DELETE' THEN
                    RAISE EXCEPTION 'job run history cannot be deleted';
                END IF;
                IF NEW.job_key <> OLD.job_key OR NEW.run_key <> OLD.run_key OR NEW.max_attempts <> OLD.max_attempts THEN
                    RAISE EXCEPTION 'a job run keeps its identity; only execution progress may change';
                END IF;
                IF OLD.status IN ('succeeded','dead_letter') AND NEW.status <> OLD.status THEN
                    RAISE EXCEPTION 'terminal job runs are final';
                END IF;
                RETURN NEW;
            END;
            $fn$ LANGUAGE plpgsql;
            SQL);
        DB::statement('CREATE TRIGGER job_runs_identity_retained_trigger BEFORE UPDATE OR DELETE ON job_runs FOR EACH ROW EXECUTE FUNCTION job_runs_identity_retained()');
    }

    public function down(): void
    {
        DB::statement('DROP TRIGGER IF EXISTS job_runs_identity_retained_trigger ON job_runs');
        DB::statement('DROP FUNCTION IF EXISTS job_runs_identity_retained()');
        Schema::dropIfExists('job_runs');
    }
};
