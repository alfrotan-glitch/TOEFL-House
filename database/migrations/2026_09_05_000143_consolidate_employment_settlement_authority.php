<?php

declare(strict_types=1);

use Illuminate\Database\Migrations\Migration;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Schema;

/**
 * Consolidates employment-settlement persistence under Finance.
 *
 * The final platform has one settlement fact: employment_settlements. The
 * Payroll proposal remains workflow evidence, while the competing
 * Payroll-owned fact is removed instead of retained as a read/write authority.
 * No financial history is rewritten; a deployment with historical rows must
 * export/reconcile those rows before this consolidation is applied.
 */
return new class extends Migration
{
    public function up(): void
    {
        // Replace the proposal guard before dropping the table it used to read.
        DB::statement(<<<'SQL'
            CREATE OR REPLACE FUNCTION settlement_proposals_guard() RETURNS trigger AS $fn$
            DECLARE
                employment_state text;
                beneficiary character(36);
                hr_clearance bigint;
                finance_clearance bigint;
                settlement_count bigint;
            BEGIN
                IF TG_OP = 'DELETE' THEN
                    RAISE EXCEPTION 'settlement proposals are auditable facts and cannot be deleted'
                        USING ERRCODE = 'check_violation';
                END IF;

                IF TG_OP = 'INSERT' THEN
                    IF NEW.lifecycle_state <> 'proposed' THEN
                        RAISE EXCEPTION 'a settlement proposal is born proposed; only approval closes it (state: %)', NEW.lifecycle_state
                            USING ERRCODE = 'check_violation';
                    END IF;

                    SELECT e.lifecycle_state, e.person_id
                      INTO employment_state, beneficiary
                      FROM employments e WHERE e.id = NEW.employment_id FOR UPDATE;
                    IF employment_state IS NULL THEN
                        RAISE EXCEPTION 'settlement proposal references missing employment %', NEW.employment_id
                            USING ERRCODE = 'foreign_key_violation';
                    END IF;
                    IF employment_state <> 'terminated' THEN
                        RAISE EXCEPTION 'a settlement proposal requires a terminated employment (currently %)', employment_state
                            USING ERRCODE = 'check_violation';
                    END IF;

                    SELECT COUNT(*) INTO hr_clearance
                      FROM payroll_clearances WHERE employment_id = NEW.employment_id AND domain = 'hr';
                    SELECT COUNT(*) INTO finance_clearance
                      FROM payroll_clearances WHERE employment_id = NEW.employment_id AND domain = 'finance';
                    IF hr_clearance = 0 OR finance_clearance = 0 THEN
                        RAISE EXCEPTION 'a settlement proposal requires both the hr and the finance clearance'
                            USING ERRCODE = 'check_violation';
                    END IF;

                    SELECT COUNT(*) INTO settlement_count
                      FROM employment_settlements WHERE employment_id = NEW.employment_id;
                    IF settlement_count > 0 THEN
                        RAISE EXCEPTION 'an employment that is already settled cannot carry a new settlement proposal'
                            USING ERRCODE = 'check_violation';
                    END IF;
                    RETURN NEW;
                END IF;

                IF OLD.lifecycle_state = 'approved' THEN
                    RAISE EXCEPTION 'an approved settlement proposal is closed'
                        USING ERRCODE = 'check_violation';
                END IF;
                IF NEW.lifecycle_state IS DISTINCT FROM 'approved' THEN
                    RAISE EXCEPTION 'a proposed settlement may only become approved (state: %)', NEW.lifecycle_state
                        USING ERRCODE = 'check_violation';
                END IF;
                IF NEW.amount IS DISTINCT FROM OLD.amount
                    OR NEW.basis IS DISTINCT FROM OLD.basis
                    OR NEW.employment_id IS DISTINCT FROM OLD.employment_id
                    OR NEW.prepared_by IS DISTINCT FROM OLD.prepared_by
                    OR NEW.created_at IS DISTINCT FROM OLD.created_at
                THEN
                    RAISE EXCEPTION 'only the lifecycle state and approved_by may change on a settlement proposal'
                        USING ERRCODE = 'check_violation';
                END IF;
                IF NEW.approved_by IS NULL THEN
                    RAISE EXCEPTION 'approving a settlement proposal requires the approver'
                        USING ERRCODE = 'check_violation';
                END IF;
                IF trim(NEW.approved_by) = trim(OLD.prepared_by) THEN
                    RAISE EXCEPTION 'settlement preparation and approval need distinct actors'
                        USING ERRCODE = 'check_violation';
                END IF;
                SELECT e.person_id INTO beneficiary
                  FROM employments e WHERE e.id = OLD.employment_id FOR UPDATE;
                IF trim(NEW.approved_by) = trim(beneficiary) THEN
                    RAISE EXCEPTION 'the beneficiary may never take part in their own settlement'
                        USING ERRCODE = 'check_violation';
                END IF;
                IF NOT EXISTS (
                    SELECT 1 FROM employment_settlements
                     WHERE proposal_id = OLD.id
                       AND employment_id = OLD.employment_id
                ) THEN
                    RAISE EXCEPTION 'a settlement proposal may be approved only after Finance records its matching settlement fact'
                        USING ERRCODE = 'check_violation';
                END IF;
                RETURN NEW;
            END;
            $fn$ LANGUAGE plpgsql;
            SQL);

        DB::statement('DROP TRIGGER IF EXISTS final_settlements_guard_trigger ON final_settlements');
        DB::statement('DROP FUNCTION IF EXISTS final_settlements_guard()');
        DB::statement('DROP TRIGGER IF EXISTS final_settlements_immutable_trigger ON final_settlements');
        DB::statement('DROP FUNCTION IF EXISTS final_settlements_immutable()');
        Schema::dropIfExists('final_settlements');
    }

    public function down(): void
    {
        // This consolidation is intentionally one-way. Recreating the removed
        // duplicate would reintroduce a competing financial authority.
        throw new \RuntimeException('The employment-settlement authority consolidation cannot be rolled back by recreating Payroll storage.');
    }
};
