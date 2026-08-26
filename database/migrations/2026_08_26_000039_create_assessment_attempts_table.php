<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Schema;

return new class extends Migration
{
    public function up(): void
    {
        Schema::create('assessment_attempts', function (Blueprint $table): void {
            $table->char('id', 36)->primary();
            $table->char('enrollment_id', 36);
            $table->string('kind');
            $table->string('evidence_ref');
            $table->string('lifecycle_state');
            $table->char('recorded_by', 36);
            $table->timestamps();
            $table->foreign('enrollment_id')->references('id')->on('enrollments');
        });
        DB::statement("ALTER TABLE assessment_attempts ADD CONSTRAINT assessment_attempts_kind_check CHECK (kind IN ('placement','assessment'))");
        DB::statement("ALTER TABLE assessment_attempts ADD CONSTRAINT assessment_attempts_lifecycle_state_check CHECK (lifecycle_state IN ('draft','started','submitted'))");
        DB::statement(<<<'SQL'
            CREATE OR REPLACE FUNCTION assessment_attempts_submitted_immutable() RETURNS trigger AS $fn$
            BEGIN
                IF OLD.lifecycle_state = 'submitted' AND (NEW.lifecycle_state IS DISTINCT FROM OLD.lifecycle_state OR NEW.evidence_ref IS DISTINCT FROM OLD.evidence_ref) THEN
                    RAISE EXCEPTION 'submitted assessment attempts are immutable evidence';
                END IF;
                RETURN NEW;
            END;
            $fn$ LANGUAGE plpgsql;
            SQL);
        DB::statement('CREATE TRIGGER assessment_attempts_submitted_immutable_trigger BEFORE UPDATE ON assessment_attempts FOR EACH ROW EXECUTE FUNCTION assessment_attempts_submitted_immutable()');
    }

    public function down(): void
    {
        DB::statement('DROP TRIGGER IF EXISTS assessment_attempts_submitted_immutable_trigger ON assessment_attempts');
        DB::statement('DROP FUNCTION IF EXISTS assessment_attempts_submitted_immutable()');
        Schema::dropIfExists('assessment_attempts');
    }
};
