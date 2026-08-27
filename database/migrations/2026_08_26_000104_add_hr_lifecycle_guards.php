<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Support\Facades\DB;

/**
 * Schema-level HR lifecycle guards — the employment and leave state
 * machines, decision evidence, and identity binding enforced at the
 * authoritative database boundary so a direct SQL UPDATE (bypassing the
 * application) can never:
 *
 *   (1) resurrect a terminated employment or skip a lifecycle step;
 *   (2) rebind an employment to a different person after creation;
 *   (3) open a second concurrent employment for the same person;
 *   (4) self-approve a leave, skip the decision step, or overlap approved
 *       leave periods of the same employment (which would corrupt payroll
 *       proration evidence);
 *   (5) rewrite the terms, requester, or decider of an already-decided
 *       leave, or revive a rejected/cancelled one.
 *
 * These triggers mirror — not replace — the domain commands
 * (MaintainEmployment, MaintainLeave), which remain the single
 * authoritative implementation of each rule.
 */
return new class extends Migration
{
    public function up(): void
    {
        DB::statement(<<<'SQL'
            CREATE OR REPLACE FUNCTION employments_lifecycle_guard() RETURNS trigger AS $fn$
            BEGIN
                IF TG_OP = 'INSERT' THEN
                    IF NEW.lifecycle_state <> 'candidate' THEN
                        RAISE EXCEPTION 'employments are created as candidate (got %)', NEW.lifecycle_state
                            USING ERRCODE = 'check_violation';
                    END IF;
                    RETURN NEW;
                END IF;

                IF NEW.person_id IS DISTINCT FROM OLD.person_id THEN
                    RAISE EXCEPTION 'an employment cannot be rebound to a different person'
                        USING ERRCODE = 'check_violation';
                END IF;

                IF OLD.lifecycle_state = 'candidate' THEN
                    IF NEW.lifecycle_state NOT IN ('candidate', 'active', 'terminated') THEN
                        RAISE EXCEPTION 'employment cannot move from candidate to %', NEW.lifecycle_state
                            USING ERRCODE = 'check_violation';
                    END IF;
                ELSIF OLD.lifecycle_state = 'active' THEN
                    IF NEW.lifecycle_state NOT IN ('active', 'on_leave', 'suspended', 'terminated') THEN
                        RAISE EXCEPTION 'employment cannot move from active to %', NEW.lifecycle_state
                            USING ERRCODE = 'check_violation';
                    END IF;
                ELSIF OLD.lifecycle_state = 'on_leave' THEN
                    IF NEW.lifecycle_state NOT IN ('on_leave', 'active', 'suspended', 'terminated') THEN
                        RAISE EXCEPTION 'employment cannot move from on_leave to %', NEW.lifecycle_state
                            USING ERRCODE = 'check_violation';
                    END IF;
                ELSIF OLD.lifecycle_state = 'suspended' THEN
                    IF NEW.lifecycle_state NOT IN ('suspended', 'active', 'terminated') THEN
                        RAISE EXCEPTION 'employment cannot move from suspended to %', NEW.lifecycle_state
                            USING ERRCODE = 'check_violation';
                    END IF;
                ELSE
                    RAISE EXCEPTION 'a terminated employment is final; resurrection is rejected'
                        USING ERRCODE = 'check_violation';
                END IF;

                RETURN NEW;
            END;
            $fn$ LANGUAGE plpgsql;
            SQL);
        DB::statement('DROP TRIGGER IF EXISTS employments_lifecycle_guard_trigger ON employments');
        DB::statement('CREATE TRIGGER employments_lifecycle_guard_trigger BEFORE INSERT OR UPDATE ON employments FOR EACH ROW EXECUTE FUNCTION employments_lifecycle_guard()');

        DB::statement(<<<'SQL'
            CREATE OR REPLACE FUNCTION leaves_lifecycle_guard() RETURNS trigger AS $fn$
            DECLARE
                overlap_exists boolean;
            BEGIN
                IF TG_OP = 'UPDATE' THEN
                    IF NEW.requested_by IS DISTINCT FROM OLD.requested_by
                        OR NEW.employment_id IS DISTINCT FROM OLD.employment_id
                        OR NEW.category IS DISTINCT FROM OLD.category
                        OR NEW.date_from IS DISTINCT FROM OLD.date_from
                        OR NEW.date_to IS DISTINCT FROM OLD.date_to
                        OR NEW.reason IS DISTINCT FROM OLD.reason THEN
                        RAISE EXCEPTION 'leave terms and requester are fixed at request time; corrections cancel and re-request'
                            USING ERRCODE = 'check_violation';
                    END IF;

                    IF OLD.lifecycle_state = 'requested' THEN
                        IF NEW.lifecycle_state NOT IN ('requested', 'approved', 'rejected', 'cancelled') THEN
                            RAISE EXCEPTION 'leave cannot move from requested to %', NEW.lifecycle_state
                                USING ERRCODE = 'check_violation';
                        END IF;
                    ELSIF OLD.lifecycle_state = 'approved' THEN
                        IF NEW.lifecycle_state NOT IN ('approved', 'cancelled') THEN
                            RAISE EXCEPTION 'an approved leave may only be cancelled (not to %)', NEW.lifecycle_state
                                USING ERRCODE = 'check_violation';
                        END IF;
                    ELSE
                        RAISE EXCEPTION 'a % leave is final; revival is rejected', OLD.lifecycle_state
                            USING ERRCODE = 'check_violation';
                    END IF;
                ELSE
                    IF NEW.lifecycle_state NOT IN ('requested', 'approved') THEN
                        RAISE EXCEPTION 'leaves are created as requested or approved (got %)', NEW.lifecycle_state
                            USING ERRCODE = 'check_violation';
                    END IF;
                    IF NEW.lifecycle_state = 'requested' AND NEW.decided_by IS NOT NULL THEN
                        RAISE EXCEPTION 'a requested leave cannot carry a decider yet'
                            USING ERRCODE = 'check_violation';
                    END IF;
                END IF;

                IF NEW.lifecycle_state = 'approved' THEN
                    IF NEW.decided_by IS NULL OR trim(NEW.decided_by) = '' THEN
                        RAISE EXCEPTION 'an approved leave requires its decider'
                            USING ERRCODE = 'check_violation';
                    END IF;

                    IF TG_OP = 'UPDATE' THEN
                        IF trim(NEW.decided_by) = trim(OLD.requested_by) THEN
                            RAISE EXCEPTION 'the leave decider must differ from the requester'
                                USING ERRCODE = 'check_violation';
                        END IF;
                    ELSIF trim(NEW.decided_by) = trim(NEW.requested_by) THEN
                        RAISE EXCEPTION 'the leave decider must differ from the requester'
                            USING ERRCODE = 'check_violation';
                    END IF;

                    SELECT EXISTS(
                        SELECT 1 FROM leaves l
                         WHERE l.employment_id = NEW.employment_id
                           AND l.lifecycle_state = 'approved'
                           AND l.id <> NEW.id
                           AND l.date_from <= NEW.date_to
                           AND l.date_to >= NEW.date_from
                    ) INTO overlap_exists;
                    IF overlap_exists THEN
                        RAISE EXCEPTION 'approved leave periods may not overlap for the same employment'
                            USING ERRCODE = 'check_violation';
                    END IF;
                END IF;

                RETURN NEW;
            END;
            $fn$ LANGUAGE plpgsql;
            SQL);
        DB::statement('DROP TRIGGER IF EXISTS leaves_lifecycle_guard_trigger ON leaves');
        DB::statement('CREATE TRIGGER leaves_lifecycle_guard_trigger BEFORE INSERT OR UPDATE ON leaves FOR EACH ROW EXECUTE FUNCTION leaves_lifecycle_guard()');

        DB::statement('DROP INDEX IF EXISTS employments_one_open_per_person');
        DB::statement("CREATE UNIQUE INDEX employments_one_open_per_person ON employments (person_id) WHERE lifecycle_state IN ('candidate', 'active', 'on_leave', 'suspended')");
    }

    public function down(): void
    {
        DB::statement('DROP INDEX IF EXISTS employments_one_open_per_person');
        DB::statement('DROP TRIGGER IF EXISTS leaves_lifecycle_guard_trigger ON leaves');
        DB::statement('DROP FUNCTION IF EXISTS leaves_lifecycle_guard()');
        DB::statement('DROP TRIGGER IF EXISTS employments_lifecycle_guard_trigger ON employments');
        DB::statement('DROP FUNCTION IF EXISTS employments_lifecycle_guard()');
    }
};
