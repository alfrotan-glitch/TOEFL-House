<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Schema;

return new class extends Migration
{
    public function up(): void
    {
        Schema::create('admission_decisions', function (Blueprint $table): void {
            $table->char('id', 36)->primary();
            $table->char('applicant_id', 36);
            $table->string('outcome');
            $table->string('reason');
            $table->string('evidence_ref');
            $table->char('initiator_id', 36);
            $table->char('reviewer_id', 36);
            $table->char('approver_id', 36);
            $table->timestamps();
            $table->foreign('applicant_id')->references('id')->on('applicants');
        });
        DB::statement("ALTER TABLE admission_decisions ADD CONSTRAINT admission_decisions_outcome_check CHECK (outcome IN ('admit','reject'))");
        DB::statement(<<<'SQL'
            CREATE OR REPLACE FUNCTION admission_decisions_append_only() RETURNS trigger AS $fn$
            BEGIN
                RAISE EXCEPTION 'admission_decisions is append-only';
            END;
            $fn$ LANGUAGE plpgsql;
            SQL);
        DB::statement('CREATE TRIGGER admission_decisions_append_only_trigger BEFORE UPDATE OR DELETE ON admission_decisions FOR EACH ROW EXECUTE FUNCTION admission_decisions_append_only()');
    }

    public function down(): void
    {
        DB::statement('DROP TRIGGER IF EXISTS admission_decisions_append_only_trigger ON admission_decisions');
        DB::statement('DROP FUNCTION IF EXISTS admission_decisions_append_only()');
        Schema::dropIfExists('admission_decisions');
    }
};
