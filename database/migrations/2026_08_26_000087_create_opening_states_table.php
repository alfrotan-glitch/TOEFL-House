<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Schema;

return new class extends Migration
{
    public function up(): void
    {
        Schema::create('opening_states', function (Blueprint $table): void {
            $table->char('id', 36)->primary();
            $table->char('organization_id', 36);
            $table->string('status');
            $table->date('effective_on');
            $table->string('opening_period_key');
            $table->char('prepared_by', 36);
            $table->timestampTz('submitted_at')->nullable();
            $table->char('approved_by', 36)->nullable();
            $table->timestampTz('approved_at')->nullable();
            $table->string('approval_digest', 64)->nullable();
            $table->timestamps();
            $table->foreign('organization_id')->references('id')->on('organizations');
        });
        // the opening financial state exists exactly once per organization — draft or not
        DB::statement('CREATE UNIQUE INDEX opening_states_one_per_organization ON opening_states (organization_id)');
        DB::statement("ALTER TABLE opening_states ADD CONSTRAINT opening_states_status_check CHECK (status IN ('draft','submitted','approved'))");
        DB::statement("ALTER TABLE opening_states ADD CONSTRAINT opening_states_approval_evidence_check CHECK ((status = 'approved') = (approved_by IS NOT NULL AND approved_at IS NOT NULL AND approval_digest IS NOT NULL AND submitted_at IS NOT NULL))");
        DB::statement('ALTER TABLE opening_states ADD CONSTRAINT opening_states_distinct_approvers_check CHECK (approved_by IS NULL OR approved_by <> prepared_by)');
        DB::statement(<<<'SQL'
            CREATE OR REPLACE FUNCTION opening_states_controlled_path() RETURNS trigger AS $fn$
            BEGIN
                IF TG_OP = 'DELETE' THEN
                    RAISE EXCEPTION 'opening state history cannot be deleted';
                END IF;
                IF NEW.id <> OLD.id OR NEW.organization_id <> OLD.organization_id
                    OR NEW.prepared_by <> OLD.prepared_by OR NEW.effective_on <> OLD.effective_on
                    OR NEW.opening_period_key <> OLD.opening_period_key THEN
                    RAISE EXCEPTION 'an opening state keeps its identity forever';
                END IF;
                IF OLD.status = 'approved' AND NEW.status <> 'approved' THEN
                    RAISE EXCEPTION 'the approved opening state is immutable';
                END IF;
                IF NOT (
                    (OLD.status = 'draft' AND NEW.status IN ('draft','submitted'))
                    OR (OLD.status = 'submitted' AND NEW.status = 'approved')
                    OR (OLD.status = NEW.status)
                ) THEN
                    RAISE EXCEPTION 'opening state may only move draft -> submitted -> approved';
                END IF;
                IF OLD.status = NEW.status AND OLD.status <> 'draft' THEN
                    RAISE EXCEPTION 'submitted and approved opening states are frozen';
                END IF;
                RETURN NEW;
            END;
            $fn$ LANGUAGE plpgsql;
            SQL);
        DB::statement('CREATE TRIGGER opening_states_controlled_path_trigger BEFORE UPDATE OR DELETE ON opening_states FOR EACH ROW EXECUTE FUNCTION opening_states_controlled_path()');
    }

    public function down(): void
    {
        DB::statement('DROP TRIGGER IF EXISTS opening_states_controlled_path_trigger ON opening_states');
        DB::statement('DROP FUNCTION IF EXISTS opening_states_controlled_path()');
        Schema::dropIfExists('opening_states');
    }
};
