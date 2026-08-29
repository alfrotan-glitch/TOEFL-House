<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Support\Facades\DB;

/**
 * Staged settlement approvals (PHASE_3) — the termination settlement
 * becomes two-session, matching the staged SoD pattern the architecture
 * already uses for refunds (000110), admissions (000111), discounts
 * (proposed -> approved) and contract versions:
 *
 *   - a settlement is BORN as a PROPOSAL: a PREPARER session (holding
 *     payroll.settle) proposes an amount and its declared evidence basis
 *     against a terminated employment that already holds BOTH the hr and
 *     the finance clearance;
 *   - an APPROVER session (a different person, holding
 *     payroll.settle_approve) approves the proposal — the only path by
 *     which the immutable final_settlements fact (guarded by 000103) is
 *     recorded.
 *
 * The transport previously received both signatures from a single request
 * (the caller typed the colleague's person id), which voided the SoD the
 * command and schema enforce on the stored identities. With staging,
 * each signature is captured in its own authenticated session.
 *
 * Schema: settlement_proposals gains lifecycle_state
 * ('proposed' | 'approved'); approved_by is nullable until approval.
 * One open proposal per employment (partial unique index). The
 * settlement_proposals_guard consolidates the boundary rules:
 *
 *   - INSERT: a proposal is born proposed, only for a terminated
 *     employment that already holds both clearances and is not yet
 *     settled (row-locked on the employment);
 *   - UPDATE: only proposed -> approved, and only the lifecycle state
 *     and approved_by may change; the approver must differ from the
 *     preparer and from the beneficiary (the 000103 checks mirrored at
 *     the proposal boundary);
 *   - DELETE: never (a proposal is an auditable fact).
 *
 * final_settlements stays exactly as guarded before (000056 immutable,
 * 000103 derivation).
 */
return new class extends Migration
{
    public function up(): void
    {
        DB::statement(<<<'SQL'
            CREATE TABLE settlement_proposals (
                id character(36) PRIMARY KEY,
                employment_id character(36) NOT NULL REFERENCES employments (id),
                amount numeric(14, 2) NOT NULL,
                basis text NOT NULL,
                lifecycle_state character varying NOT NULL DEFAULT 'proposed',
                prepared_by character(36) NOT NULL,
                approved_by character(36),
                created_at timestamptz NOT NULL,
                updated_at timestamptz NOT NULL
            )
            SQL);
        DB::statement('ALTER TABLE settlement_proposals ADD CONSTRAINT settlement_proposals_amount_check CHECK (amount >= 0)');
        DB::statement('ALTER TABLE settlement_proposals ADD CONSTRAINT settlement_proposals_basis_check CHECK (char_length(basis) > 0)');
        DB::statement("ALTER TABLE settlement_proposals ADD CONSTRAINT settlement_proposals_lifecycle_state_check CHECK (lifecycle_state IN ('proposed', 'approved'))");
        DB::statement('CREATE UNIQUE INDEX settlement_proposals_one_open_per_employment ON settlement_proposals (employment_id) WHERE lifecycle_state = \'proposed\'');

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
                      FROM final_settlements WHERE employment_id = NEW.employment_id;
                    IF settlement_count > 0 THEN
                        RAISE EXCEPTION 'an employment that is already settled cannot carry a new settlement proposal'
                            USING ERRCODE = 'check_violation';
                    END IF;

                    RETURN NEW;
                END IF;

                -- UPDATE
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

                RETURN NEW;
            END;
            $fn$ LANGUAGE plpgsql;
            SQL);
        DB::statement('CREATE TRIGGER settlement_proposals_guard_trigger BEFORE INSERT OR UPDATE OR DELETE ON settlement_proposals FOR EACH ROW EXECUTE FUNCTION settlement_proposals_guard()');
    }

    public function down(): void
    {
        DB::statement('DROP TRIGGER IF EXISTS settlement_proposals_guard_trigger ON settlement_proposals');
        DB::statement('DROP FUNCTION IF EXISTS settlement_proposals_guard()');
        DB::statement('DROP INDEX IF EXISTS settlement_proposals_one_open_per_employment');
        DB::statement('DROP TABLE IF EXISTS settlement_proposals');
    }
};
