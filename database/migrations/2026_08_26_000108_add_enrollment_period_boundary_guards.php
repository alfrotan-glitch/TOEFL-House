<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Support\Facades\DB;

/**
 * Cross-module boundary invariants (PHASE_2) — enforced at the authoritative
 * database boundary so a direct SQL statement (bypassing the application)
 * can never:
 *
 *   (1) hold two open (requested, active or frozen) enrollment seats for
 *       the same (student, class) pair (duplicate tuition, duplicate
 *       roster entries) — this broader partial unique index replaces the
 *       narrower enrollments_one_active_seat from 000037, which it fully
 *       subsumes;
 *   (2) create an enrollment seat for a student whose latest verified
 *       status is not active, or into a class that is not active, or in a
 *       state other than requested (a seat is always born requested);
 *   (3) move a seat between classes in place (a transfer closes the old
 *       seat as a terminal tombstone and opens a new requested seat);
 *   (4) activate a seat when the class is not active or its active-seat
 *       count already meets capacity (class_full);
 *   (5) tombstone a seat as transferred while the student's latest
 *       verified status is not active (the app re-verifies on transfer);
 *   (6) break the enrollment state machine (requested -> active, then
 *       freeze/transfer/withdraw/complete; transferred, withdrawn and
 *       completed are terminal);
 *   (7) close a financial period while an open or calculating payroll
 *       period overlaps its dates, rewrite a period's date scope (fixed at
 *       open), or change a closed financial period (closed is terminal —
 *       no reopen, no mutation).
 *
 * The two-open-teacher-assignment invariant is already enforced by the
 * base schema (teacher_assignments_one_open_per_class_teacher, 000036);
 * this migration does not duplicate it.
 *
 * These constraints mirror — not replace — the domain commands
 * (MaintainEnrollment, MaintainClass, MaintainFinancialPeriod,
 * MaintainPayrollPeriod), which remain the single authoritative
 * implementation of each rule.
 */
return new class extends Migration
{
    public function up(): void
    {
        DB::statement('DROP INDEX IF EXISTS enrollments_one_active_seat');
        DB::statement('DROP INDEX IF EXISTS enrollments_one_open_seat');
        DB::statement('CREATE UNIQUE INDEX enrollments_one_open_seat ON enrollments (student_id, class_id) WHERE lifecycle_state IN (\'requested\', \'active\', \'frozen\')');

        DB::statement(<<<'SQL'
            CREATE OR REPLACE FUNCTION enrollments_guard() RETURNS trigger AS $fn$
            DECLARE
                student_state text;
                class_state text;
                class_capacity integer;
            BEGIN
                IF NEW.lifecycle_state <> 'requested' THEN
                    RAISE EXCEPTION 'a new enrollment seat is born requested, not %', NEW.lifecycle_state
                        USING ERRCODE = 'check_violation';
                END IF;

                SELECT s.status INTO student_state
                  FROM student_statuses s
                 WHERE s.student_id = NEW.student_id
                 ORDER BY s.seq DESC
                 LIMIT 1
                 FOR UPDATE;

                IF student_state IS DISTINCT FROM 'active' THEN
                    RAISE EXCEPTION 'enrollment requires a currently active student (latest status: %)', student_state
                        USING ERRCODE = 'check_violation';
                END IF;

                SELECT c.lifecycle_state, c.capacity INTO class_state, class_capacity
                  FROM classes c
                 WHERE c.id = NEW.class_id
                 FOR UPDATE;

                IF class_state IS NULL THEN
                    RAISE EXCEPTION 'enrollment requires an existing class'
                        USING ERRCODE = 'foreign_key_violation';
                END IF;
                IF class_state <> 'active' THEN
                    RAISE EXCEPTION 'enrollment requires an active class (class state: %)', class_state
                        USING ERRCODE = 'check_violation';
                END IF;

                RETURN NEW;
            END;
            $fn$ LANGUAGE plpgsql;
            SQL);
        DB::statement('DROP TRIGGER IF EXISTS enrollments_guard_trigger ON enrollments');
        DB::statement('CREATE TRIGGER enrollments_guard_trigger BEFORE INSERT ON enrollments FOR EACH ROW EXECUTE FUNCTION enrollments_guard()');

        DB::statement(<<<'SQL'
            CREATE OR REPLACE FUNCTION enrollments_update_guard() RETURNS trigger AS $fn$
            DECLARE
                student_state text;
                class_state text;
                class_capacity integer;
                active_seats integer;
            BEGIN
                IF OLD.class_id IS DISTINCT FROM NEW.class_id THEN
                    RAISE EXCEPTION 'an enrollment seat cannot be moved between classes (a transfer closes this seat and opens a new requested seat)'
                        USING ERRCODE = 'check_violation';
                END IF;

                IF NEW.lifecycle_state IS DISTINCT FROM OLD.lifecycle_state THEN
                    IF OLD.lifecycle_state = 'requested' THEN
                        IF NEW.lifecycle_state NOT IN ('active', 'withdrawn') THEN
                            RAISE EXCEPTION 'enrollment state cannot move from requested to %', NEW.lifecycle_state
                                USING ERRCODE = 'check_violation';
                        END IF;
                    ELSIF OLD.lifecycle_state = 'active' THEN
                        IF NEW.lifecycle_state NOT IN ('frozen', 'transferred', 'withdrawn', 'completed') THEN
                            RAISE EXCEPTION 'enrollment state cannot move from active to %', NEW.lifecycle_state
                                USING ERRCODE = 'check_violation';
                        END IF;
                    ELSIF OLD.lifecycle_state = 'frozen' THEN
                        IF NEW.lifecycle_state NOT IN ('active', 'withdrawn') THEN
                            RAISE EXCEPTION 'enrollment state cannot move from frozen to %', NEW.lifecycle_state
                                USING ERRCODE = 'check_violation';
                        END IF;
                    ELSE
                        RAISE EXCEPTION 'enrollment state % is terminal', OLD.lifecycle_state
                            USING ERRCODE = 'check_violation';
                    END IF;
                END IF;

                IF NEW.lifecycle_state = 'active' AND OLD.lifecycle_state <> 'active' THEN
                    SELECT c.lifecycle_state, c.capacity INTO class_state, class_capacity
                      FROM classes c
                     WHERE c.id = NEW.class_id
                     FOR UPDATE;

                    IF class_state IS DISTINCT FROM 'active' THEN
                        RAISE EXCEPTION 'activating a seat requires an active class (class state: %)', class_state
                            USING ERRCODE = 'check_violation';
                    END IF;

                    SELECT count(*) INTO active_seats
                      FROM enrollments e
                     WHERE e.class_id = NEW.class_id
                       AND e.lifecycle_state = 'active';

                    IF active_seats >= class_capacity THEN
                        RAISE EXCEPTION 'class % is full (%/% active seats)', NEW.class_id, active_seats, class_capacity
                            USING ERRCODE = 'check_violation';
                    END IF;
                END IF;

                IF NEW.lifecycle_state = 'transferred' AND OLD.lifecycle_state <> 'transferred' THEN
                    SELECT s.status INTO student_state
                      FROM student_statuses s
                     WHERE s.student_id = NEW.student_id
                     ORDER BY s.seq DESC
                     LIMIT 1
                     FOR UPDATE;

                    IF student_state IS DISTINCT FROM 'active' THEN
                        RAISE EXCEPTION 'transferring a seat requires a currently active student (latest status: %)', student_state
                            USING ERRCODE = 'check_violation';
                    END IF;
                END IF;

                RETURN NEW;
            END;
            $fn$ LANGUAGE plpgsql;
            SQL);
        DB::statement('DROP TRIGGER IF EXISTS enrollments_update_guard_trigger ON enrollments');
        DB::statement('CREATE TRIGGER enrollments_update_guard_trigger BEFORE UPDATE ON enrollments FOR EACH ROW EXECUTE FUNCTION enrollments_update_guard()');

        DB::statement(<<<'SQL'
            CREATE OR REPLACE FUNCTION financial_periods_close_guard() RETURNS trigger AS $fn$
            DECLARE
                open_payroll integer;
            BEGIN
                -- The period's date scope is fixed at open and never
                -- rewritten; the app has no date-mutation command.
                IF OLD.date_from IS DISTINCT FROM NEW.date_from
                   OR OLD.date_to IS DISTINCT FROM NEW.date_to THEN
                    RAISE EXCEPTION 'a financial period date scope is fixed at open (no date mutation)'
                        USING ERRCODE = 'check_violation';
                END IF;

                -- Closed is terminal: nothing about a closed period changes.
                IF OLD.lifecycle_state = 'closed' AND OLD IS DISTINCT FROM NEW THEN
                    RAISE EXCEPTION 'a closed financial period is terminal and immutable'
                        USING ERRCODE = 'check_violation';
                END IF;

                IF NEW.lifecycle_state = 'closed' AND OLD.lifecycle_state <> 'closed' THEN
                    SELECT count(*) INTO open_payroll
                      FROM payroll_periods p
                     WHERE p.lifecycle_state <> 'closed'
                       AND p.date_from <= NEW.date_to
                       AND p.date_to >= NEW.date_from;

                    IF open_payroll > 0 THEN
                        RAISE EXCEPTION 'financial period % cannot close while % payroll period(s) overlap its dates open', NEW.period_key, open_payroll
                            USING ERRCODE = 'check_violation';
                    END IF;
                END IF;

                RETURN NEW;
            END;
            $fn$ LANGUAGE plpgsql;
            SQL);
        DB::statement('DROP TRIGGER IF EXISTS financial_periods_close_guard_trigger ON financial_periods');
        DB::statement('CREATE TRIGGER financial_periods_close_guard_trigger BEFORE UPDATE ON financial_periods FOR EACH ROW EXECUTE FUNCTION financial_periods_close_guard()');
    }

    public function down(): void
    {
        DB::statement('DROP TRIGGER IF EXISTS financial_periods_close_guard_trigger ON financial_periods');
        DB::statement('DROP FUNCTION IF EXISTS financial_periods_close_guard()');
        DB::statement('DROP TRIGGER IF EXISTS enrollments_update_guard_trigger ON enrollments');
        DB::statement('DROP FUNCTION IF EXISTS enrollments_update_guard()');
        DB::statement('DROP TRIGGER IF EXISTS enrollments_guard_trigger ON enrollments');
        DB::statement('DROP FUNCTION IF EXISTS enrollments_guard()');
        DB::statement('DROP INDEX IF EXISTS enrollments_one_open_seat');
        DB::statement('CREATE UNIQUE INDEX enrollments_one_active_seat ON enrollments (student_id, class_id) WHERE lifecycle_state = \'active\'');
    }
};
