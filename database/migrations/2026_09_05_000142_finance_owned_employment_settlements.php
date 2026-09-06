<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Schema;

/**
 * Moves the authoritative recorded termination settlement into Finance.
 * Payroll settlement proposals remain workflow evidence; this table is the
 * only new recorded employment-settlement financial fact.
 */
return new class extends Migration
{
    public function up(): void
    {
        Schema::create('employment_settlements', function (Blueprint $table): void {
            $table->char('id', 36)->primary();
            $table->char('employment_id', 36);
            $table->char('proposal_id', 36);
            $table->decimal('amount', 14, 2);
            $table->string('basis');
            $table->char('prepared_by', 36);
            $table->char('approved_by', 36);
            $table->timestamps();
            $table->foreign('employment_id')->references('id')->on('employments');
            $table->foreign('proposal_id')->references('id')->on('settlement_proposals');
            $table->foreign('prepared_by')->references('id')->on('people');
            $table->foreign('approved_by')->references('id')->on('people');
        });
        DB::statement('ALTER TABLE employment_settlements ADD CONSTRAINT employment_settlements_amount_check CHECK (amount >= 0)');
        DB::statement('ALTER TABLE employment_settlements ADD CONSTRAINT employment_settlements_basis_check CHECK (basis <> \'\')');
        DB::statement('CREATE UNIQUE INDEX employment_settlements_one_per_employment ON employment_settlements (employment_id)');
        DB::statement(<<<'SQL'
            CREATE OR REPLACE FUNCTION employment_settlements_guard() RETURNS trigger AS $fn$
            DECLARE
                beneficiary char(36);
                proposal_employment char(36);
                proposal_amount numeric;
                proposal_basis text;
                proposal_prepared_by char(36);
                proposal_state text;
            BEGIN
                IF TG_OP <> 'INSERT' THEN
                    RAISE EXCEPTION 'Finance employment settlements are immutable recorded facts; corrections append compensating Finance facts'
                        USING ERRCODE = 'check_violation';
                END IF;
                SELECT e.person_id INTO beneficiary FROM employments e
                 WHERE e.id = NEW.employment_id AND e.lifecycle_state = 'terminated';
                IF beneficiary IS NULL THEN
                    RAISE EXCEPTION 'a Finance employment settlement requires terminated employment'
                        USING ERRCODE = 'check_violation';
                END IF;
                SELECT employment_id, amount, basis, prepared_by, lifecycle_state
                  INTO proposal_employment, proposal_amount, proposal_basis, proposal_prepared_by, proposal_state
                  FROM settlement_proposals WHERE id = NEW.proposal_id;
                IF proposal_employment IS NULL OR proposal_state <> 'proposed'
                   OR proposal_employment <> NEW.employment_id
                   OR proposal_amount IS DISTINCT FROM NEW.amount
                   OR proposal_basis IS DISTINCT FROM NEW.basis
                   OR proposal_prepared_by IS DISTINCT FROM NEW.prepared_by THEN
                    RAISE EXCEPTION 'a Finance employment settlement requires a matching proposed Payroll settlement'
                        USING ERRCODE = 'check_violation';
                END IF;
                IF trim(NEW.prepared_by) = trim(NEW.approved_by) OR trim(NEW.approved_by) = trim(beneficiary) THEN
                    RAISE EXCEPTION 'a Finance employment settlement requires independent preparation, approval, and beneficiary separation'
                        USING ERRCODE = 'check_violation';
                END IF;
                IF NOT EXISTS (
                    SELECT 1 FROM payroll_clearances pc
                     WHERE pc.employment_id = NEW.employment_id AND pc.domain = 'hr'
                ) OR NOT EXISTS (
                    SELECT 1 FROM payroll_clearances pc
                     WHERE pc.employment_id = NEW.employment_id AND pc.domain = 'finance'
                ) THEN
                    RAISE EXCEPTION 'a Finance employment settlement requires HR and Finance clearance evidence'
                        USING ERRCODE = 'check_violation';
                END IF;
                IF NOT EXISTS (
                    SELECT 1 FROM people p
                    JOIN branches b ON b.id = p.home_branch_id
                    WHERE p.id = beneficiary AND b.lifecycle_state = 'active'
                ) THEN
                    RAISE EXCEPTION 'a Finance employment settlement requires known active employee branch provenance'
                        USING ERRCODE = 'check_violation';
                END IF;
                RETURN NEW;
            END;
            $fn$ LANGUAGE plpgsql;
            SQL);
        DB::statement('CREATE TRIGGER employment_settlements_guard_trigger BEFORE INSERT ON employment_settlements FOR EACH ROW EXECUTE FUNCTION employment_settlements_guard()');
        DB::statement(<<<'SQL'
            CREATE OR REPLACE FUNCTION employment_settlements_immutable() RETURNS trigger AS $fn$
            BEGIN
                RAISE EXCEPTION 'Finance employment settlements are immutable recorded facts; corrections append compensating Finance facts';
            END;
            $fn$ LANGUAGE plpgsql;
            SQL);
        DB::statement('CREATE TRIGGER employment_settlements_immutable_trigger BEFORE UPDATE OR DELETE ON employment_settlements FOR EACH ROW EXECUTE FUNCTION employment_settlements_immutable()');
    }

    public function down(): void
    {
        DB::statement('DROP TRIGGER IF EXISTS employment_settlements_guard_trigger ON employment_settlements');
        DB::statement('DROP FUNCTION IF EXISTS employment_settlements_guard()');
        DB::statement('DROP TRIGGER IF EXISTS employment_settlements_immutable_trigger ON employment_settlements');
        DB::statement('DROP FUNCTION IF EXISTS employment_settlements_immutable()');
        Schema::dropIfExists('employment_settlements');
    }
};
