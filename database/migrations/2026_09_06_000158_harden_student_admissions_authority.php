<?php

declare(strict_types=1);

use Illuminate\Database\Migrations\Migration;
use Illuminate\Support\Facades\DB;

/**
 * Student/Admissions authority hardening.
 *
 * This migration closes the remaining static integrity gaps at the database
 * boundary without creating a second business authority:
 *
 * - one open admission file per person is enforced under concurrency;
 * - new applicant branch anchors are complete and immutable (there is no
 *   applicant-transfer command yet);
 * - applicant admitted/rejected state changes are backed by a final decision;
 * - a Student can only be born from its own final admitted decision/person and
 *   matching branch provenance;
 * - Student current-home changes require the newest append-only transfer row;
 * - status and transfer facts cannot be backdated or scheduled by raw SQL;
 * - a Student transaction cannot commit without its initial active status.
 *
 * Commands remain the user-facing authority for authorization, evidence,
 * idempotency, and audit. These guards protect the same invariants from raw
 * SQL, alternate transports, and concurrent writers.
 */
return new class extends Migration
{
    public function up(): void
    {
        DB::statement("CREATE UNIQUE INDEX applicants_one_open_per_person ON applicants (person_id) WHERE lifecycle_state IN ('prospect', 'applicant', 'admitted')");
        // This index is an invariant consolidated from 2026_08_26_000107; it is
        // already created there, so refresh it rather than fail a fresh install.
        DB::statement('DROP INDEX IF EXISTS students_one_per_admission_decision');
        DB::statement('CREATE UNIQUE INDEX students_one_per_admission_decision ON students (admission_decision_id)');

        DB::statement(<<<'SQL'
            CREATE OR REPLACE FUNCTION applicants_anchor_guard() RETURNS trigger AS $fn$
            BEGIN
                IF TG_OP = 'INSERT' THEN
                    IF NEW.originating_branch_id IS NULL OR trim(NEW.originating_branch_id) = ''
                       OR NEW.current_home_branch_id IS NULL OR trim(NEW.current_home_branch_id) = ''
                       OR NEW.originating_branch_id IS DISTINCT FROM NEW.current_home_branch_id THEN
                        RAISE EXCEPTION 'a new applicant requires matching originating and current-home branch provenance'
                            USING ERRCODE = 'check_violation';
                    END IF;
                ELSE
                    IF OLD.originating_branch_id IS DISTINCT FROM NEW.originating_branch_id
                       OR OLD.current_home_branch_id IS DISTINCT FROM NEW.current_home_branch_id THEN
                        RAISE EXCEPTION 'applicant branch provenance is immutable until an explicit applicant transfer authority exists'
                            USING ERRCODE = 'check_violation';
                    END IF;
                END IF;

                RETURN NEW;
            END;
            $fn$ LANGUAGE plpgsql;
            SQL);
        DB::statement('DROP TRIGGER IF EXISTS applicants_anchor_guard_trigger ON applicants');
        DB::statement('CREATE TRIGGER applicants_anchor_guard_trigger BEFORE INSERT OR UPDATE OF originating_branch_id, current_home_branch_id ON applicants FOR EACH ROW EXECUTE FUNCTION applicants_anchor_guard()');

        DB::statement(<<<'SQL'
            CREATE OR REPLACE FUNCTION applicants_lifecycle_guard() RETURNS trigger AS $fn$
            BEGIN
                IF TG_OP = 'INSERT' THEN
                    IF NEW.lifecycle_state NOT IN ('prospect', 'applicant') THEN
                        RAISE EXCEPTION 'an applicant is born prospect or applicant, not %', NEW.lifecycle_state
                            USING ERRCODE = 'check_violation';
                    END IF;
                    RETURN NEW;
                END IF;

                IF OLD.lifecycle_state IS NOT DISTINCT FROM NEW.lifecycle_state THEN
                    RETURN NEW;
                END IF;

                IF OLD.lifecycle_state = 'applicant'
                   AND NEW.lifecycle_state IN ('admitted', 'rejected') THEN
                    IF NOT EXISTS (
                        SELECT 1
                          FROM admission_decisions d
                         WHERE d.applicant_id = NEW.id
                           AND d.lifecycle_state = 'final'
                           AND ((NEW.lifecycle_state = 'admitted' AND d.outcome = 'admit')
                             OR (NEW.lifecycle_state = 'rejected' AND d.outcome = 'reject'))
                    ) THEN
                        RAISE EXCEPTION 'an applicant can become admitted or rejected only through a matching final admission decision'
                            USING ERRCODE = 'check_violation';
                    END IF;
                    RETURN NEW;
                END IF;

                -- Re-application is a deliberate new decision on the same
                -- admission file. The command layer audits and authorizes it;
                -- the database preserves the legal lifecycle edge.
                IF OLD.lifecycle_state = 'rejected' AND NEW.lifecycle_state = 'applicant' THEN
                    RETURN NEW;
                END IF;

                RAISE EXCEPTION 'applicant lifecycle transition % -> % is not permitted', OLD.lifecycle_state, NEW.lifecycle_state
                    USING ERRCODE = 'check_violation';
            END;
            $fn$ LANGUAGE plpgsql;
            SQL);
        DB::statement('DROP TRIGGER IF EXISTS applicants_lifecycle_guard_trigger ON applicants');
        DB::statement('CREATE TRIGGER applicants_lifecycle_guard_trigger BEFORE INSERT OR UPDATE OF lifecycle_state ON applicants FOR EACH ROW EXECUTE FUNCTION applicants_lifecycle_guard()');

        DB::statement(<<<'SQL'
            CREATE OR REPLACE FUNCTION applicants_reapplication_guard() RETURNS trigger AS $fn$
            BEGIN
                IF TG_OP = 'INSERT'
                   AND EXISTS (
                       SELECT 1 FROM applicants a
                        WHERE a.person_id = NEW.person_id
                          AND a.lifecycle_state = 'rejected'
                   ) THEN
                    RAISE EXCEPTION 'a rejected admission file must be explicitly reopened; a second file cannot bypass its history'
                        USING ERRCODE = 'check_violation';
                END IF;
                RETURN NEW;
            END;
            $fn$ LANGUAGE plpgsql;
            SQL);
        DB::statement('DROP TRIGGER IF EXISTS applicants_reapplication_guard_trigger ON applicants');
        DB::statement('CREATE TRIGGER applicants_reapplication_guard_trigger BEFORE INSERT ON applicants FOR EACH ROW EXECUTE FUNCTION applicants_reapplication_guard()');

        DB::statement(<<<'SQL'
            CREATE OR REPLACE FUNCTION students_admission_authority_guard() RETURNS trigger AS $fn$
            DECLARE
                decision_outcome text;
                decision_state text;
                applicant_state text;
                applicant_person char(36);
                applicant_origin char(36);
                applicant_home char(36);
                expected_branch char(36);
            BEGIN
                SELECT d.outcome, d.lifecycle_state, a.lifecycle_state, a.person_id,
                       a.originating_branch_id, a.current_home_branch_id
                  INTO decision_outcome, decision_state, applicant_state, applicant_person,
                       applicant_origin, applicant_home
                  FROM admission_decisions d
                  JOIN applicants a ON a.id = d.applicant_id
                 WHERE d.id = NEW.admission_decision_id
                 FOR UPDATE;

                IF decision_outcome IS NULL THEN
                    RAISE EXCEPTION 'a Student requires an existing admission decision and applicant'
                        USING ERRCODE = 'foreign_key_violation';
                END IF;
                IF decision_state <> 'final' OR decision_outcome <> 'admit' OR applicant_state <> 'admitted' THEN
                    RAISE EXCEPTION 'a Student requires a final admitted admission decision'
                        USING ERRCODE = 'check_violation';
                END IF;
                IF trim(NEW.person_id) <> trim(applicant_person) THEN
                    RAISE EXCEPTION 'Student person must match the admitted applicant person'
                        USING ERRCODE = 'check_violation';
                END IF;

                expected_branch := COALESCE(NULLIF(trim(applicant_home), ''), NULLIF(trim(applicant_origin), ''));
                IF expected_branch IS NULL OR trim(NEW.originating_branch_id) <> trim(expected_branch) THEN
                    RAISE EXCEPTION 'Student originating branch must match the applicant current-home provenance'
                        USING ERRCODE = 'check_violation';
                END IF;
                IF NEW.current_home_branch_id IS NULL OR trim(NEW.current_home_branch_id) = '' THEN
                    RAISE EXCEPTION 'Student current-home branch provenance is required'
                        USING ERRCODE = 'check_violation';
                END IF;

                IF TG_OP = 'UPDATE' THEN
                    IF OLD.person_id IS DISTINCT FROM NEW.person_id
                       OR OLD.admission_decision_id IS DISTINCT FROM NEW.admission_decision_id
                       OR OLD.originating_branch_id IS DISTINCT FROM NEW.originating_branch_id THEN
                        RAISE EXCEPTION 'Student person, admission decision, and originating branch are immutable'
                            USING ERRCODE = 'check_violation';
                    END IF;
                    IF OLD.current_home_branch_id IS DISTINCT FROM NEW.current_home_branch_id
                       AND NOT EXISTS (
                           SELECT 1
                             FROM student_branch_transfers t
                            WHERE t.student_id = NEW.id
                              AND t.seq = (SELECT max(latest.seq) FROM student_branch_transfers latest WHERE latest.student_id = NEW.id)
                              AND t.from_branch_id IS NOT DISTINCT FROM OLD.current_home_branch_id
                              AND t.to_branch_id = NEW.current_home_branch_id
                       ) THEN
                        RAISE EXCEPTION 'Student current-home changes require the newest matching branch-transfer fact'
                            USING ERRCODE = 'check_violation';
                    END IF;
                ELSE
                    IF NEW.current_home_branch_id IS DISTINCT FROM NEW.originating_branch_id THEN
                        RAISE EXCEPTION 'a Student is born in its originating current-home branch'
                            USING ERRCODE = 'check_violation';
                    END IF;
                END IF;

                RETURN NEW;
            END;
            $fn$ LANGUAGE plpgsql;
            SQL);
        DB::statement('DROP TRIGGER IF EXISTS students_admission_authority_guard_trigger ON students');
        DB::statement('CREATE TRIGGER students_admission_authority_guard_trigger BEFORE INSERT OR UPDATE OF person_id, admission_decision_id, originating_branch_id, current_home_branch_id ON students FOR EACH ROW EXECUTE FUNCTION students_admission_authority_guard()');

        DB::statement(<<<'SQL'
            CREATE OR REPLACE FUNCTION student_status_current_day_guard() RETURNS trigger AS $fn$
            BEGIN
                IF NEW.effective_from <> CURRENT_DATE THEN
                    RAISE EXCEPTION 'Student status facts must be effective on the append date; corrections append a new current fact'
                        USING ERRCODE = 'check_violation';
                END IF;
                RETURN NEW;
            END;
            $fn$ LANGUAGE plpgsql;
            SQL);
        DB::statement('DROP TRIGGER IF EXISTS student_status_current_day_guard_trigger ON student_statuses');
        DB::statement('CREATE TRIGGER student_status_current_day_guard_trigger BEFORE INSERT ON student_statuses FOR EACH ROW EXECUTE FUNCTION student_status_current_day_guard()');

        DB::statement(<<<'SQL'
            CREATE OR REPLACE FUNCTION student_status_transition_guard() RETURNS trigger AS $fn$
            DECLARE
                previous_status text;
            BEGIN
                SELECT status INTO previous_status
                  FROM student_statuses
                 WHERE student_id = NEW.student_id
                 ORDER BY seq DESC
                 LIMIT 1;

                IF previous_status IS NULL THEN
                    IF NEW.status <> 'active' THEN
                        RAISE EXCEPTION 'a Student history must begin with active status'
                            USING ERRCODE = 'check_violation';
                    END IF;
                ELSIF NOT (
                    (previous_status = 'active' AND NEW.status IN ('suspended', 'withdrawn', 'completed'))
                    OR (previous_status IN ('suspended', 'withdrawn') AND NEW.status = 'active')
                    OR (previous_status = 'completed' AND NEW.status = 'alumni')
                ) THEN
                    RAISE EXCEPTION 'Student status transition % -> % is not permitted', previous_status, NEW.status
                        USING ERRCODE = 'check_violation';
                END IF;

                RETURN NEW;
            END;
            $fn$ LANGUAGE plpgsql;
            SQL);
        DB::statement('DROP TRIGGER IF EXISTS student_status_transition_guard_trigger ON student_statuses');
        DB::statement('CREATE TRIGGER student_status_transition_guard_trigger BEFORE INSERT ON student_statuses FOR EACH ROW EXECUTE FUNCTION student_status_transition_guard()');

        DB::statement(<<<'SQL'
            CREATE OR REPLACE FUNCTION student_transfer_current_day_guard() RETURNS trigger AS $fn$
            BEGIN
                IF NEW.effective_from <> CURRENT_DATE THEN
                    RAISE EXCEPTION 'Student branch transfers must be effective on the append date; scheduled transfers require an explicit authority'
                        USING ERRCODE = 'check_violation';
                END IF;
                RETURN NEW;
            END;
            $fn$ LANGUAGE plpgsql;
            SQL);
        DB::statement('DROP TRIGGER IF EXISTS student_transfer_current_day_guard_trigger ON student_branch_transfers');
        DB::statement('CREATE TRIGGER student_transfer_current_day_guard_trigger BEFORE INSERT ON student_branch_transfers FOR EACH ROW EXECUTE FUNCTION student_transfer_current_day_guard()');

        DB::statement(<<<'SQL'
            CREATE OR REPLACE FUNCTION students_require_initial_active_status() RETURNS trigger AS $fn$
            BEGIN
                IF NOT EXISTS (
                    SELECT 1 FROM student_statuses s
                     WHERE s.student_id = NEW.id
                       AND s.status = 'active'
                ) THEN
                    RAISE EXCEPTION 'a Student transaction must create its initial active status history row'
                        USING ERRCODE = 'check_violation';
                END IF;
                RETURN NEW;
            END;
            $fn$ LANGUAGE plpgsql;
            SQL);
        DB::statement('DROP TRIGGER IF EXISTS students_require_initial_active_status_trigger ON students');
        DB::statement('CREATE CONSTRAINT TRIGGER students_require_initial_active_status_trigger AFTER INSERT ON students DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION students_require_initial_active_status()');

        DB::statement('CREATE INDEX IF NOT EXISTS student_statuses_student_seq_index ON student_statuses (student_id, seq DESC)');
        DB::statement('CREATE INDEX IF NOT EXISTS student_branch_transfers_student_seq_index ON student_branch_transfers (student_id, seq DESC)');
    }

    public function down(): void
    {
        DB::statement('DROP INDEX IF EXISTS student_branch_transfers_student_seq_index');
        DB::statement('DROP INDEX IF EXISTS student_statuses_student_seq_index');
        DB::statement('DROP TRIGGER IF EXISTS students_require_initial_active_status_trigger ON students');
        DB::statement('DROP FUNCTION IF EXISTS students_require_initial_active_status()');
        DB::statement('DROP TRIGGER IF EXISTS student_transfer_current_day_guard_trigger ON student_branch_transfers');
        DB::statement('DROP FUNCTION IF EXISTS student_transfer_current_day_guard()');
        DB::statement('DROP TRIGGER IF EXISTS student_status_transition_guard_trigger ON student_statuses');
        DB::statement('DROP FUNCTION IF EXISTS student_status_transition_guard()');
        DB::statement('DROP TRIGGER IF EXISTS student_status_current_day_guard_trigger ON student_statuses');
        DB::statement('DROP FUNCTION IF EXISTS student_status_current_day_guard()');
        DB::statement('DROP TRIGGER IF EXISTS students_admission_authority_guard_trigger ON students');
        DB::statement('DROP FUNCTION IF EXISTS students_admission_authority_guard()');
        DB::statement('DROP TRIGGER IF EXISTS applicants_reapplication_guard_trigger ON applicants');
        DB::statement('DROP FUNCTION IF EXISTS applicants_reapplication_guard()');
        DB::statement('DROP TRIGGER IF EXISTS applicants_lifecycle_guard_trigger ON applicants');
        DB::statement('DROP FUNCTION IF EXISTS applicants_lifecycle_guard()');
        DB::statement('DROP TRIGGER IF EXISTS applicants_anchor_guard_trigger ON applicants');
        DB::statement('DROP FUNCTION IF EXISTS applicants_anchor_guard()');
        DB::statement('DROP INDEX IF EXISTS students_one_per_admission_decision');
        DB::statement('DROP INDEX IF EXISTS applicants_one_open_per_person');
    }
};
