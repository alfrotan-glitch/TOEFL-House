<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Support\Facades\DB;

/**
 * Schema-level student invariants — enforced at the authoritative database
 * boundary so a direct SQL INSERT (bypassing the application) can never:
 *
 *   (1) create a second student record for the same person (duplicate
 *       enrollment and duplicate tuition obligations);
 *   (2) create a second student from the same admission decision;
 *   (3) fabricate student status history: the first status is the
 *       conversion status (active), every later status is a verified
 *       registry transition from the latest status, and each row carries
 *       its reason. Status is history, never an overwrite.
 *
 * These constraints mirror — not replace — the domain commands
 * (EnrollAdmittedApplicant, TransitionStudentStatus), which remain the
 * single authoritative implementation of each rule.
 */
return new class extends Migration
{
    public function up(): void
    {
        DB::statement('DROP INDEX IF EXISTS students_one_per_person');
        DB::statement('CREATE UNIQUE INDEX students_one_per_person ON students (person_id)');
        DB::statement('DROP INDEX IF EXISTS students_one_per_admission_decision');
        DB::statement('CREATE UNIQUE INDEX students_one_per_admission_decision ON students (admission_decision_id)');

        DB::statement(<<<'SQL'
            CREATE OR REPLACE FUNCTION student_statuses_guard() RETURNS trigger AS $fn$
            DECLARE
                previous_status text;
            BEGIN
                IF NEW.reason IS NULL OR trim(NEW.reason) = '' THEN
                    RAISE EXCEPTION 'a student status history row requires its reason'
                        USING ERRCODE = 'check_violation';
                END IF;

                SELECT s.status INTO previous_status
                  FROM student_statuses s
                 WHERE s.student_id = NEW.student_id
                 ORDER BY s.seq DESC
                 LIMIT 1
                 FOR UPDATE;

                IF previous_status IS NULL THEN
                    IF NEW.status <> 'active' THEN
                        RAISE EXCEPTION 'the first student status is the conversion status (active), not %',
                            NEW.status
                            USING ERRCODE = 'check_violation';
                    END IF;
                    RETURN NEW;
                END IF;

                IF previous_status = 'active' THEN
                    IF NEW.status NOT IN ('suspended', 'withdrawn', 'completed') THEN
                        RAISE EXCEPTION 'student status cannot move from active to %', NEW.status
                            USING ERRCODE = 'check_violation';
                    END IF;
                ELSIF previous_status IN ('suspended', 'withdrawn') THEN
                    IF NEW.status <> 'active' THEN
                        RAISE EXCEPTION 'student status cannot move from % to % (only reactivation)', previous_status, NEW.status
                            USING ERRCODE = 'check_violation';
                    END IF;
                ELSIF previous_status = 'completed' THEN
                    IF NEW.status <> 'alumni' THEN
                        RAISE EXCEPTION 'student status cannot move from completed to %', NEW.status
                            USING ERRCODE = 'check_violation';
                    END IF;
                ELSE
                    RAISE EXCEPTION 'a student with alumni status is final'
                        USING ERRCODE = 'check_violation';
                END IF;

                RETURN NEW;
            END;
            $fn$ LANGUAGE plpgsql;
            SQL);
        DB::statement('DROP TRIGGER IF EXISTS student_statuses_guard_trigger ON student_statuses');
        DB::statement('CREATE TRIGGER student_statuses_guard_trigger BEFORE INSERT ON student_statuses FOR EACH ROW EXECUTE FUNCTION student_statuses_guard()');
    }

    public function down(): void
    {
        DB::statement('DROP TRIGGER IF EXISTS student_statuses_guard_trigger ON student_statuses');
        DB::statement('DROP FUNCTION IF EXISTS student_statuses_guard()');
        DB::statement('DROP INDEX IF EXISTS students_one_per_admission_decision');
        DB::statement('DROP INDEX IF EXISTS students_one_per_person');
    }
};
