<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Support\Facades\DB;

/**
 * Schema-level payroll guards — the payroll invariants enforced at the
 * authoritative database boundary so a direct SQL INSERT (bypassing the
 * application) can never forge a payable:
 *
 *   (1) payroll_results: an approved result is a pure derivation of its
 *       calculation — same amount (base_amount), same period, same
 *       employment, and only an approvable (prepared or resulted)
 *       calculation can ever carry a result.
 *   (2) payroll_adjustments: corrections are impossible once the payroll
 *       period is closed, and a result can be reversed at most once.
 *   (3) final_settlements: a termination settlement exists only for a
 *       terminated employment, only after the hr AND finance clearances,
 *       only once per employment, with preparation and approval by
 *       distinct actors, neither of whom is the beneficiary.
 *
 * These triggers mirror — not replace — the domain commands
 * (ApprovePayrollResult, SettleEmployment), which remain the single
 * authoritative implementation of each rule.
 */
return new class extends Migration
{
    public function up(): void
    {
        DB::statement(<<<'SQL'
            CREATE OR REPLACE FUNCTION payroll_results_derivation_guard() RETURNS trigger AS $fn$
            DECLARE
                calc_base numeric;
                calc_period char(36);
                calc_employment char(36);
                calc_state text;
            BEGIN
                SELECT pc.base_amount, pc.period_id, pc.employment_id, pc.lifecycle_state
                  INTO calc_base, calc_period, calc_employment, calc_state
                  FROM payroll_calculations pc WHERE pc.id = NEW.calculation_id FOR UPDATE;
                IF calc_base IS NULL THEN
                    RAISE EXCEPTION 'payroll result references missing calculation %', NEW.calculation_id
                        USING ERRCODE = 'foreign_key_violation';
                END IF;

                IF calc_state NOT IN ('prepared', 'resulted') THEN
                    RAISE EXCEPTION 'payroll result references a % calculation; only a prepared calculation can carry a result',
                        calc_state
                        USING ERRCODE = 'check_violation';
                END IF;

                IF NEW.amount <> calc_base THEN
                    RAISE EXCEPTION 'payroll result amount (%) differs from the calculation base amount (%)',
                        NEW.amount, calc_base
                        USING ERRCODE = 'check_violation';
                END IF;

                IF NEW.period_id <> calc_period OR NEW.employment_id <> calc_employment THEN
                    RAISE EXCEPTION 'payroll result references a different period or employment than its calculation %',
                        NEW.calculation_id
                        USING ERRCODE = 'check_violation';
                END IF;

                RETURN NEW;
            END;
            $fn$ LANGUAGE plpgsql;
            SQL);
        DB::statement('DROP TRIGGER IF EXISTS payroll_results_derivation_guard_trigger ON payroll_results');
        DB::statement('CREATE TRIGGER payroll_results_derivation_guard_trigger AFTER INSERT ON payroll_results FOR EACH ROW EXECUTE FUNCTION payroll_results_derivation_guard()');

        DB::statement(<<<'SQL'
            CREATE OR REPLACE FUNCTION payroll_adjustments_guard() RETURNS trigger AS $fn$
            DECLARE
                result_period char(36);
                period_state text;
                reversal_count bigint;
            BEGIN
                SELECT pr.period_id INTO result_period
                  FROM payroll_results pr WHERE pr.id = NEW.result_id FOR UPDATE;
                IF result_period IS NULL THEN
                    RAISE EXCEPTION 'payroll adjustment references missing result %', NEW.result_id
                        USING ERRCODE = 'foreign_key_violation';
                END IF;

                SELECT pp.lifecycle_state INTO period_state
                  FROM payroll_periods pp WHERE pp.id = result_period FOR UPDATE;
                IF period_state = 'closed' THEN
                    RAISE EXCEPTION 'payroll adjustments are impossible once the payroll period is closed'
                        USING ERRCODE = 'check_violation';
                END IF;

                IF NEW.kind = 'reversal' THEN
                    SELECT COUNT(*) INTO reversal_count
                      FROM payroll_adjustments
                     WHERE result_id = NEW.result_id AND kind = 'reversal';
                    IF reversal_count > 1 THEN
                        RAISE EXCEPTION 'a payroll result can be reversed at most once'
                            USING ERRCODE = 'check_violation';
                    END IF;
                END IF;

                RETURN NEW;
            END;
            $fn$ LANGUAGE plpgsql;
            SQL);
        DB::statement('DROP TRIGGER IF EXISTS payroll_adjustments_guard_trigger ON payroll_adjustments');
        DB::statement('CREATE TRIGGER payroll_adjustments_guard_trigger AFTER INSERT ON payroll_adjustments FOR EACH ROW EXECUTE FUNCTION payroll_adjustments_guard()');

        DB::statement(<<<'SQL'
            CREATE OR REPLACE FUNCTION final_settlements_guard() RETURNS trigger AS $fn$
            DECLARE
                employment_state text;
                beneficiary char(36);
                hr_clearance bigint;
                finance_clearance bigint;
                settlement_count bigint;
            BEGIN
                SELECT e.lifecycle_state, e.person_id
                  INTO employment_state, beneficiary
                  FROM employments e WHERE e.id = NEW.employment_id FOR UPDATE;
                IF employment_state IS NULL THEN
                    RAISE EXCEPTION 'final settlement references missing employment %', NEW.employment_id
                        USING ERRCODE = 'foreign_key_violation';
                END IF;

                IF employment_state <> 'terminated' THEN
                    RAISE EXCEPTION 'a final settlement requires a terminated employment (currently %)',
                        employment_state
                        USING ERRCODE = 'check_violation';
                END IF;

                IF trim(NEW.prepared_by) = trim(beneficiary) OR trim(NEW.approved_by) = trim(beneficiary) THEN
                    RAISE EXCEPTION 'the beneficiary may never take part in their own settlement'
                        USING ERRCODE = 'check_violation';
                END IF;

                IF trim(NEW.prepared_by) = trim(NEW.approved_by) THEN
                    RAISE EXCEPTION 'settlement preparation and approval need distinct actors'
                        USING ERRCODE = 'check_violation';
                END IF;

                SELECT COUNT(*) INTO hr_clearance
                  FROM payroll_clearances WHERE employment_id = NEW.employment_id AND domain = 'hr';
                SELECT COUNT(*) INTO finance_clearance
                  FROM payroll_clearances WHERE employment_id = NEW.employment_id AND domain = 'finance';
                IF hr_clearance = 0 OR finance_clearance = 0 THEN
                    RAISE EXCEPTION 'a final settlement requires both the hr and the finance clearance'
                        USING ERRCODE = 'check_violation';
                END IF;

                SELECT COUNT(*) INTO settlement_count
                  FROM final_settlements WHERE employment_id = NEW.employment_id;
                IF settlement_count > 1 THEN
                    RAISE EXCEPTION 'an employment can be settled only once'
                        USING ERRCODE = 'check_violation';
                END IF;

                RETURN NEW;
            END;
            $fn$ LANGUAGE plpgsql;
            SQL);
        DB::statement('DROP TRIGGER IF EXISTS final_settlements_guard_trigger ON final_settlements');
        DB::statement('CREATE TRIGGER final_settlements_guard_trigger AFTER INSERT ON final_settlements FOR EACH ROW EXECUTE FUNCTION final_settlements_guard()');
    }

    public function down(): void
    {
        DB::statement('DROP TRIGGER IF EXISTS final_settlements_guard_trigger ON final_settlements');
        DB::statement('DROP FUNCTION IF EXISTS final_settlements_guard()');
        DB::statement('DROP TRIGGER IF EXISTS payroll_adjustments_guard_trigger ON payroll_adjustments');
        DB::statement('DROP FUNCTION IF EXISTS payroll_adjustments_guard()');
        DB::statement('DROP TRIGGER IF EXISTS payroll_results_derivation_guard_trigger ON payroll_results');
        DB::statement('DROP FUNCTION IF EXISTS payroll_results_derivation_guard()');
    }
};
