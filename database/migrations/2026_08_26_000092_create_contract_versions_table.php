<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Schema;

return new class extends Migration
{
    public function up(): void
    {
        Schema::create('contract_versions', function (Blueprint $table): void {
            $table->char('id', 36)->primary();
            $table->char('contract_id', 36);
            $table->integer('version_no');
            $table->string('lifecycle_state');
            $table->string('terms_ref');
            $table->char('scale_id', 36)->nullable();
            $table->date('effective_from');
            $table->date('effective_to')->nullable();
            $table->char('prepared_by', 36);
            $table->timestamp('submitted_at')->nullable();
            $table->char('approved_by', 36)->nullable();
            $table->timestamp('approved_at')->nullable();
            $table->string('approval_digest')->nullable();
            $table->timestamps();
            $table->foreign('contract_id')->references('id')->on('contracts');
            $table->foreign('scale_id')->references('id')->on('scales');
        });
        DB::statement("ALTER TABLE contract_versions ADD CONSTRAINT contract_versions_lifecycle_state_check CHECK (lifecycle_state IN ('draft','submitted','approved','active','superseded','expired','withdrawn'))");
        DB::statement('ALTER TABLE contract_versions ADD CONSTRAINT contract_versions_period_check CHECK (effective_to IS NULL OR effective_to > effective_from)');
        DB::statement(<<<'SQL'
            ALTER TABLE contract_versions ADD CONSTRAINT contract_versions_approval_evidence_check CHECK (
                (lifecycle_state IN ('approved','active','superseded','expired')) = (approved_by IS NOT NULL AND approved_at IS NOT NULL AND approval_digest IS NOT NULL)
            )
            SQL);
        DB::statement(<<<'SQL'
            ALTER TABLE contract_versions ADD CONSTRAINT contract_versions_submitted_evidence_check CHECK (
                lifecycle_state NOT IN ('submitted','approved','active','superseded','expired') OR submitted_at IS NOT NULL
            )
            SQL);
        DB::statement('ALTER TABLE contract_versions ADD CONSTRAINT contract_versions_approver_independence_check CHECK (approved_by IS NULL OR approved_by <> prepared_by)');
        DB::statement('CREATE UNIQUE INDEX contract_versions_no_unique ON contract_versions (contract_id, version_no)');
        DB::statement("CREATE UNIQUE INDEX contract_versions_one_in_preparation_per_contract ON contract_versions (contract_id) WHERE lifecycle_state IN ('draft','submitted')");
        DB::statement(<<<'SQL'
            CREATE OR REPLACE FUNCTION contract_versions_lifecycle_guard() RETURNS trigger AS $fn$
            BEGIN
                IF OLD.lifecycle_state = 'draft' THEN
                    IF NEW.lifecycle_state NOT IN ('draft','submitted','withdrawn') THEN
                        RAISE EXCEPTION 'draft contract version cannot move to %', NEW.lifecycle_state;
                    END IF;
                    RETURN NEW;
                ELSIF OLD.lifecycle_state = 'submitted' THEN
                    IF NEW.lifecycle_state NOT IN ('submitted','approved','active','withdrawn') THEN
                        RAISE EXCEPTION 'submitted contract version cannot move to %', NEW.lifecycle_state;
                    END IF;
                    IF NEW.lifecycle_state = OLD.lifecycle_state AND (
                        NEW.contract_id <> OLD.contract_id OR NEW.version_no <> OLD.version_no OR NEW.terms_ref <> OLD.terms_ref
                        OR NEW.scale_id IS DISTINCT FROM OLD.scale_id OR NEW.effective_from <> OLD.effective_from OR NEW.effective_to IS DISTINCT FROM OLD.effective_to
                        OR NEW.prepared_by <> OLD.prepared_by OR NEW.submitted_at <> OLD.submitted_at
                        OR NEW.approved_by IS DISTINCT FROM OLD.approved_by OR NEW.approved_at IS DISTINCT FROM OLD.approved_at OR NEW.approval_digest IS DISTINCT FROM OLD.approval_digest) THEN
                        RAISE EXCEPTION 'a submitted contract version is frozen until approval; withdraw and prepare a new version instead';
                    END IF;
                    RETURN NEW;
                ELSIF OLD.lifecycle_state IN ('approved','active') THEN
                    IF NEW.lifecycle_state NOT IN (OLD.lifecycle_state, 'superseded','expired') THEN
                        RAISE EXCEPTION 'contract version cannot move from % to %', OLD.lifecycle_state, NEW.lifecycle_state;
                    END IF;
                    IF NEW.lifecycle_state IN ('superseded','expired') THEN
                        IF NEW.contract_id <> OLD.contract_id OR NEW.version_no <> OLD.version_no OR NEW.terms_ref <> OLD.terms_ref
                            OR NEW.scale_id IS DISTINCT FROM OLD.scale_id OR NEW.effective_from <> OLD.effective_from OR NEW.prepared_by <> OLD.prepared_by
                            OR NEW.submitted_at <> OLD.submitted_at OR NEW.approved_by <> OLD.approved_by OR NEW.approved_at <> OLD.approved_at OR NEW.approval_digest <> OLD.approval_digest THEN
                            RAISE EXCEPTION 'approved contract versions are immutable; only the lifecycle state and the window end may advance';
                        END IF;
                        RETURN NEW;
                    END IF;
                    IF NEW.lifecycle_state <> OLD.lifecycle_state THEN
                        RAISE EXCEPTION 'approved contract version state can only advance to superseded or expired';
                    END IF;
                    RAISE EXCEPTION 'approved or active contract versions are immutable; a change is a new effective version';
                ELSE
                    RAISE EXCEPTION 'terminal contract versions are immutable history';
                END IF;
            END;
            $fn$ LANGUAGE plpgsql;
            SQL);
        DB::statement('CREATE TRIGGER contract_versions_lifecycle_guard_trigger BEFORE UPDATE ON contract_versions FOR EACH ROW EXECUTE FUNCTION contract_versions_lifecycle_guard()');
        DB::statement(<<<'SQL'
            CREATE OR REPLACE FUNCTION contract_versions_no_delete() RETURNS trigger AS $fn$
            BEGIN
                RAISE EXCEPTION 'contract versions are retained approval history and cannot be deleted';
            END;
            $fn$ LANGUAGE plpgsql;
            SQL);
        DB::statement('CREATE TRIGGER contract_versions_no_delete_trigger BEFORE DELETE ON contract_versions FOR EACH ROW EXECUTE FUNCTION contract_versions_no_delete()');
    }

    public function down(): void
    {
        DB::statement('DROP TRIGGER IF EXISTS contract_versions_no_delete_trigger ON contract_versions');
        DB::statement('DROP FUNCTION IF EXISTS contract_versions_no_delete()');
        DB::statement('DROP TRIGGER IF EXISTS contract_versions_lifecycle_guard_trigger ON contract_versions');
        DB::statement('DROP FUNCTION IF EXISTS contract_versions_lifecycle_guard()');
        Schema::dropIfExists('contract_versions');
    }
};
