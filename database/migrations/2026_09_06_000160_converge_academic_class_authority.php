<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Schema;

/**
 * Final academic-class authority boundary for the pre-production schema.
 *
 * A delivery class is not an unowned copy of a program/term tuple: every new
 * class is anchored to one open Offering. Offering, class and enrollment
 * identity is immutable; all live enrollment states claim capacity; and the
 * same database locks/counts are used for request, activation and waitlist
 * promotion. The application commands remain the human-facing policy owner,
 * while these guards are the last line for direct SQL and concurrent writers.
 *
 * Existing rows with incomplete historical provenance are intentionally not
 * fabricated or backfilled. They remain readable only through the governed
 * remediation paths; all newly written delivery facts satisfy the authority
 * contract below.
 */
return new class extends Migration
{
    public function up(): void
    {
        Schema::table('classes', function (Blueprint $table): void {
            $table->char('offering_id', 36)->nullable()->after('branch_id');
            $table->foreign('offering_id')->references('id')->on('offerings');
        });
        Schema::table('progression_decisions', function (Blueprint $table): void {
            $table->char('appeal_reviewed_by', 36)->nullable()->after('reviewed_by');
        });
        DB::statement('CREATE INDEX classes_offering_lifecycle_index ON classes (offering_id, lifecycle_state)');

        DB::statement(<<<'SQL'
            CREATE OR REPLACE FUNCTION academic_scope_branch_guard() RETURNS trigger AS $fn$
            BEGIN
                IF NOT EXISTS (
                    SELECT 1
                      FROM branches b
                      JOIN campus_assignments ca ON ca.branch_id = b.id
                      JOIN campuses c ON c.id = ca.campus_id
                      JOIN organizations o ON o.id = c.organization_id
                     WHERE b.id = NEW.branch_id
                       AND b.lifecycle_state = 'active'
                       AND c.lifecycle_state = 'active'
                       AND o.lifecycle_state = 'active'
                       AND ca.effective_from <= CURRENT_DATE
                       AND (ca.effective_to IS NULL OR ca.effective_to > CURRENT_DATE)
                ) THEN
                    RAISE EXCEPTION 'academic branch provenance requires active branch, campus and organization topology'
                        USING ERRCODE = 'check_violation';
                END IF;
                RETURN NEW;
            END;
            $fn$ LANGUAGE plpgsql;
            SQL);
        DB::statement('CREATE TRIGGER academic_availability_scope_guard_trigger BEFORE INSERT OR UPDATE OF branch_id ON branch_availabilities FOR EACH ROW EXECUTE FUNCTION academic_scope_branch_guard()');
        DB::statement('CREATE TRIGGER academic_offering_scope_guard_trigger BEFORE INSERT OR UPDATE OF branch_id ON offerings FOR EACH ROW EXECUTE FUNCTION academic_scope_branch_guard()');
        DB::statement('CREATE TRIGGER academic_class_scope_guard_trigger BEFORE INSERT OR UPDATE OF branch_id ON classes FOR EACH ROW EXECUTE FUNCTION academic_scope_branch_guard()');

        DB::statement(<<<'SQL'
            CREATE OR REPLACE FUNCTION academic_offering_reference_guard() RETURNS trigger AS $fn$
            DECLARE
                level_state text;
                period_state text;
                program_state text;
            BEGIN
                SELECT lifecycle_state INTO level_state FROM program_version_levels WHERE id = NEW.program_version_level_id;
                SELECT p.lifecycle_state INTO program_state
                  FROM program_version_levels l
                  JOIN program_versions pv ON pv.id = l.program_version_id
                  JOIN programs p ON p.id = pv.program_id
                 WHERE l.id = NEW.program_version_level_id;
                SELECT lifecycle_state INTO period_state FROM academic_periods WHERE id = NEW.academic_period_id;
                IF program_state IS DISTINCT FROM 'published' THEN
                    RAISE EXCEPTION 'academic packaging requires a published program version'
                        USING ERRCODE = 'check_violation';
                END IF;
                IF level_state IS DISTINCT FROM 'active' THEN
                    RAISE EXCEPTION 'academic packaging requires an active program level'
                        USING ERRCODE = 'check_violation';
                END IF;
                IF period_state IS DISTINCT FROM 'published' THEN
                    RAISE EXCEPTION 'academic packaging requires a published academic period'
                        USING ERRCODE = 'check_violation';
                END IF;
                RETURN NEW;
            END;
            $fn$ LANGUAGE plpgsql;
            SQL);
        DB::statement('CREATE TRIGGER academic_availability_reference_guard_trigger BEFORE INSERT OR UPDATE OF program_version_level_id, academic_period_id ON branch_availabilities FOR EACH ROW EXECUTE FUNCTION academic_offering_reference_guard()');
        DB::statement('CREATE TRIGGER academic_offering_reference_guard_trigger BEFORE INSERT OR UPDATE OF program_version_level_id, academic_period_id ON offerings FOR EACH ROW EXECUTE FUNCTION academic_offering_reference_guard()');
        // The earlier offering guard covered every UPDATE, which accidentally
        // prevented an offering from being closed/completed after its
        // availability was closed. Lifecycle closure is valid once identity is
        // fixed; only creation, reopening, and topology changes need active
        // availability and a published period.
        DB::statement(<<<'SQL'
            CREATE OR REPLACE FUNCTION offering_requires_available_branch() RETURNS trigger AS $fn$
            DECLARE
                period_state text;
            BEGIN
                IF TG_OP = 'UPDATE' AND NEW.lifecycle_state IN ('closed', 'cancelled', 'completed') THEN
                    RETURN NEW;
                END IF;
                SELECT lifecycle_state INTO period_state
                  FROM academic_periods WHERE id = NEW.academic_period_id;
                IF period_state IS DISTINCT FROM 'published' THEN
                    RAISE EXCEPTION 'offering term must be published/open'
                        USING ERRCODE = 'check_violation';
                END IF;
                IF NOT EXISTS (
                    SELECT 1 FROM branch_availabilities ba
                     WHERE ba.branch_id = NEW.branch_id
                       AND ba.program_version_level_id = NEW.program_version_level_id
                       AND ba.academic_period_id = NEW.academic_period_id
                       AND ba.lifecycle_state = 'active'
                ) THEN
                    RAISE EXCEPTION 'offering requires an active branch availability for the branch, level and term'
                        USING ERRCODE = 'check_violation';
                END IF;
                RETURN NEW;
            END;
            $fn$ LANGUAGE plpgsql;
            SQL);

        DB::statement(<<<'SQL'
            CREATE OR REPLACE FUNCTION academic_period_authority_guard() RETURNS trigger AS $fn$
            DECLARE
                open_classes integer;
                open_offerings integer;
                active_availabilities integer;
                live_seats integer;
            BEGIN
                IF NEW.ends_on <= NEW.starts_on THEN
                    RAISE EXCEPTION 'academic period must end after it starts'
                        USING ERRCODE = 'check_violation';
                END IF;
                IF OLD.starts_on IS DISTINCT FROM NEW.starts_on
                   OR OLD.ends_on IS DISTINCT FROM NEW.ends_on THEN
                    RAISE EXCEPTION 'an academic period date window is immutable after definition'
                        USING ERRCODE = 'check_violation';
                END IF;
                IF OLD.lifecycle_state = 'draft' AND NEW.lifecycle_state <> 'published'
                   OR OLD.lifecycle_state = 'published' AND NEW.lifecycle_state NOT IN ('published', 'closed')
                   OR OLD.lifecycle_state = 'closed' AND (NEW.lifecycle_state <> 'closed' OR OLD IS DISTINCT FROM NEW) THEN
                    RAISE EXCEPTION 'academic period lifecycle transition is not allowed: % -> %', OLD.lifecycle_state, NEW.lifecycle_state
                        USING ERRCODE = 'check_violation';
                END IF;
                IF NEW.lifecycle_state = 'closed' AND OLD.lifecycle_state <> 'closed' THEN
                    PERFORM 1
                      FROM classes c
                     WHERE c.period_id = NEW.id
                     ORDER BY c.id
                     FOR UPDATE;
                    SELECT count(*) INTO open_classes
                      FROM classes c
                     WHERE c.period_id = NEW.id
                       AND c.lifecycle_state NOT IN ('cancelled', 'completed', 'archived');
                    IF open_classes > 0 THEN
                        RAISE EXCEPTION 'academic period cannot close while % class(es) are non-terminal', open_classes
                            USING ERRCODE = 'check_violation';
                    END IF;
                    PERFORM 1
                      FROM offerings o
                     WHERE o.academic_period_id = NEW.id
                     ORDER BY o.id
                     FOR UPDATE;
                    SELECT count(*) INTO open_offerings
                      FROM offerings o
                     WHERE o.academic_period_id = NEW.id
                       AND o.lifecycle_state IN ('open', 'closed');
                    IF open_offerings > 0 THEN
                        RAISE EXCEPTION 'academic period cannot close while % offering(s) are non-terminal', open_offerings
                            USING ERRCODE = 'check_violation';
                    END IF;
                    PERFORM 1
                      FROM branch_availabilities ba
                     WHERE ba.academic_period_id = NEW.id
                     ORDER BY ba.id
                     FOR UPDATE;
                    SELECT count(*) INTO active_availabilities
                      FROM branch_availabilities ba
                     WHERE ba.academic_period_id = NEW.id
                       AND ba.lifecycle_state = 'active';
                    IF active_availabilities > 0 THEN
                        RAISE EXCEPTION 'academic period cannot close while % branch availability record(s) remain active', active_availabilities
                            USING ERRCODE = 'check_violation';
                    END IF;
                    PERFORM 1
                      FROM enrollments e
                      JOIN classes c ON c.id = e.class_id
                     WHERE c.period_id = NEW.id
                       AND e.lifecycle_state IN ('requested', 'active', 'frozen')
                     ORDER BY e.id
                     FOR UPDATE OF e;
                    SELECT count(*) INTO live_seats
                      FROM enrollments e
                      JOIN classes c ON c.id = e.class_id
                     WHERE c.period_id = NEW.id
                       AND e.lifecycle_state IN ('requested', 'active', 'frozen');
                    IF live_seats > 0 THEN
                        RAISE EXCEPTION 'academic period cannot close while % live enrollment seat claim(s) remain', live_seats
                            USING ERRCODE = 'check_violation';
                    END IF;
                END IF;
                RETURN NEW;
            END;
            $fn$ LANGUAGE plpgsql;
            SQL);
        DB::statement('CREATE TRIGGER academic_period_authority_guard_trigger BEFORE UPDATE ON academic_periods FOR EACH ROW EXECUTE FUNCTION academic_period_authority_guard()');

        DB::statement(<<<'SQL'
            CREATE OR REPLACE FUNCTION academic_offering_identity_guard() RETURNS trigger AS $fn$
            BEGIN
                IF NEW.branch_id IS DISTINCT FROM OLD.branch_id
                   OR NEW.program_version_level_id IS DISTINCT FROM OLD.program_version_level_id
                   OR NEW.academic_period_id IS DISTINCT FROM OLD.academic_period_id THEN
                    RAISE EXCEPTION 'offering branch, level and period identity is immutable'
                        USING ERRCODE = 'check_violation';
                END IF;
                RETURN NEW;
            END;
            $fn$ LANGUAGE plpgsql;
            SQL);
        DB::statement('CREATE TRIGGER academic_offering_identity_guard_trigger BEFORE UPDATE OF branch_id, program_version_level_id, academic_period_id ON offerings FOR EACH ROW EXECUTE FUNCTION academic_offering_identity_guard()');

        DB::statement(<<<'SQL'
            CREATE OR REPLACE FUNCTION academic_class_authority_guard() RETURNS trigger AS $fn$
            DECLARE
                offering_branch char(36);
                offering_level char(36);
                offering_period char(36);
                offering_state text;
                offering_capacity integer;
                level_version char(36);
                program_state text;
                branch_state text;
                period_state text;
                live_seats integer;
            BEGIN
                IF TG_OP = 'UPDATE'
                   AND (NEW.branch_id IS DISTINCT FROM OLD.branch_id
                        OR NEW.period_id IS DISTINCT FROM OLD.period_id
                        OR NEW.program_version_id IS DISTINCT FROM OLD.program_version_id
                        OR NEW.program_version_level_id IS DISTINCT FROM OLD.program_version_level_id
                        OR (OLD.offering_id IS NOT NULL AND NEW.offering_id IS DISTINCT FROM OLD.offering_id)) THEN
                    RAISE EXCEPTION 'class identity and established offering provenance are immutable'
                        USING ERRCODE = 'check_violation';
                END IF;
                IF TG_OP = 'INSERT' AND NEW.offering_id IS NULL THEN
                    RAISE EXCEPTION 'new delivery classes require offering provenance'
                        USING ERRCODE = 'check_violation';
                END IF;
                IF NEW.capacity <= 0 THEN
                    RAISE EXCEPTION 'class capacity must be positive'
                        USING ERRCODE = 'check_violation';
                END IF;
                IF NEW.offering_id IS NULL THEN
                    RETURN NEW;
                END IF;

                SELECT o.branch_id, o.program_version_level_id, o.academic_period_id,
                       o.lifecycle_state, o.capacity
                  INTO offering_branch, offering_level, offering_period, offering_state, offering_capacity
                  FROM offerings o
                 WHERE o.id = NEW.offering_id
                 FOR UPDATE;
                IF offering_state IS NULL THEN
                    RAISE EXCEPTION 'class references an unknown offering'
                        USING ERRCODE = 'foreign_key_violation';
                END IF;
                IF TG_OP = 'INSERT' AND offering_state <> 'open' THEN
                    RAISE EXCEPTION 'a new class requires an open offering (state: %)', offering_state
                        USING ERRCODE = 'check_violation';
                END IF;
                IF NEW.branch_id IS DISTINCT FROM offering_branch
                   OR NEW.period_id IS DISTINCT FROM offering_period
                   OR NEW.program_version_level_id IS DISTINCT FROM offering_level THEN
                    RAISE EXCEPTION 'class offering, branch, level and period must agree'
                        USING ERRCODE = 'check_violation';
                END IF;
                IF NEW.capacity > offering_capacity THEN
                    RAISE EXCEPTION 'class capacity cannot exceed offering capacity'
                        USING ERRCODE = 'check_violation';
                END IF;

                SELECT lifecycle_state INTO branch_state FROM branches WHERE id = NEW.branch_id;
                IF branch_state IS DISTINCT FROM 'active' THEN
                    RAISE EXCEPTION 'a delivery class requires an active branch'
                        USING ERRCODE = 'check_violation';
                END IF;
                SELECT lifecycle_state INTO period_state FROM academic_periods WHERE id = NEW.period_id;
                IF period_state IS DISTINCT FROM 'published' THEN
                    RAISE EXCEPTION 'a delivery class requires a published academic period'
                        USING ERRCODE = 'check_violation';
                END IF;
                SELECT p.lifecycle_state INTO program_state
                  FROM program_versions pv JOIN programs p ON p.id = pv.program_id
                 WHERE pv.id = NEW.program_version_id;
                IF program_state IS DISTINCT FROM 'published' THEN
                    RAISE EXCEPTION 'a delivery class requires a published program version'
                        USING ERRCODE = 'check_violation';
                END IF;
                SELECT program_version_id INTO level_version FROM program_version_levels WHERE id = NEW.program_version_level_id;
                IF level_version IS NULL OR level_version IS DISTINCT FROM NEW.program_version_id THEN
                    RAISE EXCEPTION 'class level must belong to the class program version'
                        USING ERRCODE = 'check_violation';
                END IF;

                IF TG_OP = 'UPDATE' AND NEW.capacity IS DISTINCT FROM OLD.capacity THEN
                    SELECT count(*) INTO live_seats
                      FROM enrollments e
                     WHERE e.class_id = NEW.id
                       AND e.lifecycle_state IN ('requested', 'active', 'frozen');
                    IF NEW.capacity < live_seats THEN
                        RAISE EXCEPTION 'class capacity cannot fall below % live seat claim(s)', live_seats
                            USING ERRCODE = 'check_violation';
                    END IF;
                END IF;
                RETURN NEW;
            END;
            $fn$ LANGUAGE plpgsql;
            SQL);
        DB::statement('CREATE TRIGGER academic_class_authority_guard_trigger BEFORE INSERT OR UPDATE OF offering_id, branch_id, period_id, program_version_id, program_version_level_id, capacity ON classes FOR EACH ROW EXECUTE FUNCTION academic_class_authority_guard()');

        DB::statement(<<<'SQL'
            CREATE OR REPLACE FUNCTION academic_class_lifecycle_guard() RETURNS trigger AS $fn$
            DECLARE
                allowed boolean := false;
                open_teacher_count integer;
                live_seats integer;
                future_sessions integer;
                period_state text;
                offering_state text;
            BEGIN
                IF OLD.lifecycle_state = 'planned' AND NEW.lifecycle_state IN ('published', 'cancelled') THEN allowed := true; END IF;
                IF OLD.lifecycle_state = 'published' AND NEW.lifecycle_state IN ('active', 'cancelled') THEN allowed := true; END IF;
                IF OLD.lifecycle_state = 'active' AND NEW.lifecycle_state IN ('completed', 'cancelled') THEN allowed := true; END IF;
                IF OLD.lifecycle_state IN ('cancelled', 'completed') AND NEW.lifecycle_state = 'archived' THEN allowed := true; END IF;
                IF OLD.lifecycle_state = NEW.lifecycle_state THEN allowed := true; END IF;
                IF NOT allowed THEN
                    RAISE EXCEPTION 'class lifecycle transition is not allowed: % -> %', OLD.lifecycle_state, NEW.lifecycle_state
                        USING ERRCODE = 'check_violation';
                END IF;
                IF NEW.lifecycle_state IN ('published', 'active') THEN
                    SELECT lifecycle_state INTO period_state FROM academic_periods WHERE id = NEW.period_id;
                    IF period_state IS DISTINCT FROM 'published' THEN
                        RAISE EXCEPTION 'a published or active class requires a published academic period'
                            USING ERRCODE = 'check_violation';
                    END IF;
                    SELECT lifecycle_state INTO offering_state FROM offerings WHERE id = NEW.offering_id;
                    IF offering_state IN ('cancelled', 'completed') OR offering_state IS NULL THEN
                        RAISE EXCEPTION 'a published or active class requires a non-terminal offering'
                            USING ERRCODE = 'check_violation';
                    END IF;
                END IF;
                IF NEW.lifecycle_state = 'active' THEN
                    SELECT count(*) INTO open_teacher_count
                      FROM teacher_assignments ta
                     WHERE ta.class_id = NEW.id
                       AND ta.effective_to IS NULL;
                    IF open_teacher_count = 0 THEN
                        RAISE EXCEPTION 'an active class requires an open teacher assignment'
                            USING ERRCODE = 'check_violation';
                    END IF;
                END IF;
                IF NEW.lifecycle_state IN ('cancelled', 'completed') AND OLD.lifecycle_state NOT IN ('cancelled', 'completed') THEN
                    SELECT count(*) INTO live_seats
                      FROM enrollments e
                     WHERE e.class_id = NEW.id
                       AND e.lifecycle_state IN ('requested', 'active', 'frozen');
                    IF live_seats > 0 THEN
                        RAISE EXCEPTION 'class cannot become % while % live seat claim(s) remain', NEW.lifecycle_state, live_seats
                            USING ERRCODE = 'check_violation';
                    END IF;
                    SELECT count(*) INTO future_sessions
                      FROM class_sessions s
                     WHERE s.class_id = NEW.id
                       AND s.scheduled_on >= CURRENT_DATE;
                    IF future_sessions > 0 THEN
                        RAISE EXCEPTION 'class cannot become % while % future session(s) remain', NEW.lifecycle_state, future_sessions
                            USING ERRCODE = 'check_violation';
                    END IF;
                END IF;
                RETURN NEW;
            END;
            $fn$ LANGUAGE plpgsql;
            SQL);
        DB::statement('CREATE TRIGGER academic_class_lifecycle_guard_trigger BEFORE UPDATE OF lifecycle_state ON classes FOR EACH ROW EXECUTE FUNCTION academic_class_lifecycle_guard()');

        DB::statement(<<<'SQL'
            CREATE OR REPLACE FUNCTION academic_enrollment_capacity_guard() RETURNS trigger AS $fn$
            DECLARE
                class_state text;
                class_capacity integer;
                class_offering char(36);
                class_claims integer;
                offering_state text;
                offering_capacity integer;
                offering_claims integer;
            BEGIN
                IF TG_OP = 'UPDATE' AND OLD.class_id IS DISTINCT FROM NEW.class_id THEN
                    RAISE EXCEPTION 'an enrollment class is immutable; transfer closes the old row and creates a new row'
                        USING ERRCODE = 'check_violation';
                END IF;
                IF TG_OP = 'UPDATE' AND OLD.offering_id IS DISTINCT FROM NEW.offering_id THEN
                    RAISE EXCEPTION 'an enrollment offering is immutable; transfer creates a new row'
                        USING ERRCODE = 'check_violation';
                END IF;
                IF NEW.lifecycle_state NOT IN ('requested', 'active', 'frozen') THEN
                    RETURN NEW;
                END IF;

                SELECT c.lifecycle_state, c.capacity, c.offering_id
                  INTO class_state, class_capacity, class_offering
                  FROM classes c WHERE c.id = NEW.class_id FOR UPDATE;
                IF class_state IS DISTINCT FROM 'active' THEN
                    RAISE EXCEPTION 'a live enrollment seat requires an active class (state: %)', class_state
                        USING ERRCODE = 'check_violation';
                END IF;
                IF class_offering IS NOT NULL AND NEW.offering_id IS DISTINCT FROM class_offering THEN
                    RAISE EXCEPTION 'a live enrollment seat must use its class offering'
                        USING ERRCODE = 'check_violation';
                END IF;
                SELECT count(*) INTO class_claims
                  FROM enrollments e
                 WHERE e.class_id = NEW.class_id
                   AND e.lifecycle_state IN ('requested', 'active', 'frozen')
                   AND e.id <> NEW.id;
                IF class_claims >= class_capacity THEN
                    RAISE EXCEPTION 'class % is full (%/% live seat claims)', NEW.class_id, class_claims, class_capacity
                        USING ERRCODE = 'check_violation';
                END IF;

                IF NEW.offering_id IS NOT NULL THEN
                    SELECT o.lifecycle_state, o.capacity INTO offering_state, offering_capacity
                      FROM offerings o WHERE o.id = NEW.offering_id FOR UPDATE;
                    IF offering_state IS DISTINCT FROM 'open' THEN
                        RAISE EXCEPTION 'a live enrollment seat requires an open offering (state: %)', offering_state
                            USING ERRCODE = 'check_violation';
                    END IF;
                    SELECT count(*) INTO offering_claims
                      FROM enrollments e
                     WHERE e.offering_id = NEW.offering_id
                       AND e.lifecycle_state IN ('requested', 'active', 'frozen')
                       AND e.id <> NEW.id;
                    IF offering_claims >= offering_capacity THEN
                        RAISE EXCEPTION 'offering % is full (%/% live seat claims)', NEW.offering_id, offering_claims, offering_capacity
                            USING ERRCODE = 'check_violation';
                    END IF;
                END IF;
                RETURN NEW;
            END;
            $fn$ LANGUAGE plpgsql;
            SQL);
        DB::statement('CREATE TRIGGER academic_enrollment_capacity_guard_trigger BEFORE INSERT OR UPDATE OF class_id, offering_id, lifecycle_state ON enrollments FOR EACH ROW EXECUTE FUNCTION academic_enrollment_capacity_guard()');

        DB::statement(<<<'SQL'
            CREATE OR REPLACE FUNCTION academic_waitlist_reference_guard() RETURNS trigger AS $fn$
            DECLARE
                class_offering char(36);
                class_branch char(36);
                class_state text;
                offering_branch char(36);
                offering_state text;
            BEGIN
                IF TG_OP = 'UPDATE'
                   AND (NEW.class_id IS DISTINCT FROM OLD.class_id
                        OR NEW.offering_id IS DISTINCT FROM OLD.offering_id) THEN
                    RAISE EXCEPTION 'a waitlist class and offering are immutable'
                        USING ERRCODE = 'check_violation';
                END IF;
                SELECT c.offering_id, c.branch_id, c.lifecycle_state
                  INTO class_offering, class_branch, class_state
                  FROM classes c
                 WHERE c.id = NEW.class_id
                 FOR UPDATE;
                IF class_branch IS NULL THEN
                    RAISE EXCEPTION 'waitlist entries require class branch provenance'
                        USING ERRCODE = 'check_violation';
                END IF;
                IF NEW.lifecycle_state IN ('waiting', 'offered') AND class_state IS DISTINCT FROM 'active' THEN
                    RAISE EXCEPTION 'open waitlist entries require an active class'
                        USING ERRCODE = 'check_violation';
                END IF;
                IF class_offering IS NULL THEN
                    RETURN NEW;
                END IF;
                IF NEW.offering_id IS DISTINCT FROM class_offering THEN
                    RAISE EXCEPTION 'waitlist offering must match its class offering'
                        USING ERRCODE = 'check_violation';
                END IF;
                SELECT o.branch_id, o.lifecycle_state INTO offering_branch, offering_state
                  FROM offerings o
                 WHERE o.id = NEW.offering_id
                 FOR UPDATE;
                IF offering_branch IS DISTINCT FROM class_branch THEN
                    RAISE EXCEPTION 'waitlist offering must remain in the class branch'
                        USING ERRCODE = 'check_violation';
                END IF;
                IF NEW.lifecycle_state IN ('waiting', 'offered') AND offering_state IS DISTINCT FROM 'open' THEN
                    RAISE EXCEPTION 'open waitlist entries require an open offering'
                        USING ERRCODE = 'check_violation';
                END IF;
                RETURN NEW;
            END;
            $fn$ LANGUAGE plpgsql;
            SQL);
        DB::statement('CREATE TRIGGER academic_waitlist_reference_guard_trigger BEFORE INSERT OR UPDATE OF class_id, offering_id, lifecycle_state ON class_waitlist_entries FOR EACH ROW EXECUTE FUNCTION academic_waitlist_reference_guard()');

        DB::statement(<<<'SQL'
            CREATE OR REPLACE FUNCTION academic_session_scope_guard() RETURNS trigger AS $fn$
            DECLARE
                class_state text;
                class_branch char(36);
                period_start date;
                period_end date;
                room_branch char(36);
            BEGIN
                SELECT c.lifecycle_state, c.branch_id, p.starts_on, p.ends_on
                  INTO class_state, class_branch, period_start, period_end
                  FROM classes c JOIN academic_periods p ON p.id = c.period_id
                 WHERE c.id = NEW.class_id;
                IF class_state IS DISTINCT FROM 'active' THEN
                    RAISE EXCEPTION 'sessions require an active class'
                        USING ERRCODE = 'check_violation';
                END IF;
                IF class_branch IS NULL THEN
                    RAISE EXCEPTION 'sessions require class branch provenance'
                        USING ERRCODE = 'check_violation';
                END IF;
                IF NEW.scheduled_on < period_start OR NEW.scheduled_on > period_end THEN
                    RAISE EXCEPTION 'session date must fall inside the class academic period'
                        USING ERRCODE = 'check_violation';
                END IF;
                IF NEW.room_id IS NOT NULL THEN
                    SELECT branch_id INTO room_branch FROM academic_rooms WHERE id = NEW.room_id;
                    IF room_branch IS DISTINCT FROM class_branch THEN
                        RAISE EXCEPTION 'session room must belong to the class branch'
                            USING ERRCODE = 'check_violation';
                    END IF;
                END IF;
                RETURN NEW;
            END;
            $fn$ LANGUAGE plpgsql;
            SQL);
        DB::statement('CREATE TRIGGER academic_session_scope_guard_trigger BEFORE INSERT ON class_sessions FOR EACH ROW EXECUTE FUNCTION academic_session_scope_guard()');
        DB::statement(<<<'SQL'
            CREATE OR REPLACE FUNCTION academic_session_identity_guard() RETURNS trigger AS $fn$
            BEGIN
                IF OLD.class_id IS DISTINCT FROM NEW.class_id OR OLD.skill_id IS DISTINCT FROM NEW.skill_id THEN
                    RAISE EXCEPTION 'a scheduled session class and skill are immutable; rebook through a new session'
                        USING ERRCODE = 'check_violation';
                END IF;
                RETURN NEW;
            END;
            $fn$ LANGUAGE plpgsql;
            SQL);
        DB::statement('CREATE TRIGGER academic_session_identity_guard_trigger BEFORE UPDATE ON class_sessions FOR EACH ROW EXECUTE FUNCTION academic_session_identity_guard()');

        DB::statement(<<<'SQL'
            CREATE OR REPLACE FUNCTION academic_attendance_reference_guard() RETURNS trigger AS $fn$
            DECLARE
                session_class char(36);
                enrollment_class char(36);
                enrollment_state text;
                class_state text;
                class_branch char(36);
                original_class char(36);
                original_enrollment char(36);
                original_session char(36);
            BEGIN
                SELECT cs.class_id INTO session_class FROM class_sessions cs WHERE cs.id = NEW.session_id;
                SELECT e.class_id, e.lifecycle_state, c.lifecycle_state, c.branch_id
                  INTO enrollment_class, enrollment_state, class_state, class_branch
                  FROM enrollments e JOIN classes c ON c.id = e.class_id
                 WHERE e.id = NEW.enrollment_id;
                IF session_class IS NULL OR enrollment_class IS NULL OR session_class IS DISTINCT FROM enrollment_class THEN
                    RAISE EXCEPTION 'attendance enrollment must belong to the session class'
                        USING ERRCODE = 'check_violation';
                END IF;
                IF class_branch IS NULL THEN
                    RAISE EXCEPTION 'attendance requires class branch provenance'
                        USING ERRCODE = 'check_violation';
                END IF;
                IF NEW.corrects_id IS NULL AND (enrollment_state IS DISTINCT FROM 'active' OR class_state IS DISTINCT FROM 'active') THEN
                    RAISE EXCEPTION 'original attendance requires an active enrollment in an active class'
                        USING ERRCODE = 'check_violation';
                END IF;
                IF NEW.corrects_id IS NOT NULL THEN
                    SELECT original_session_row.class_id, af.enrollment_id, af.session_id
                      INTO original_class, original_enrollment, original_session
                      FROM attendance_facts af
                      JOIN class_sessions original_session_row ON original_session_row.id = af.session_id
                      WHERE af.id = NEW.corrects_id;
                    IF original_class IS DISTINCT FROM session_class
                       OR original_enrollment IS DISTINCT FROM NEW.enrollment_id
                       OR original_session IS DISTINCT FROM NEW.session_id
                       OR NEW.reason IS NULL OR char_length(trim(NEW.reason)) = 0 THEN
                        RAISE EXCEPTION 'attendance corrections must cite a same-session fact and a reason'
                            USING ERRCODE = 'check_violation';
                    END IF;
                END IF;
                RETURN NEW;
            END;
            $fn$ LANGUAGE plpgsql;
            SQL);
        DB::statement('CREATE TRIGGER academic_attendance_reference_guard_trigger BEFORE INSERT ON attendance_facts FOR EACH ROW EXECUTE FUNCTION academic_attendance_reference_guard()');

        DB::statement(<<<'SQL'
            CREATE OR REPLACE FUNCTION academic_assessment_attempt_guard() RETURNS trigger AS $fn$
            DECLARE
                enrollment_state text;
                class_state text;
                class_branch char(36);
            BEGIN
                IF TG_OP = 'UPDATE' THEN
                    IF OLD.enrollment_id IS DISTINCT FROM NEW.enrollment_id
                       OR OLD.kind IS DISTINCT FROM NEW.kind
                       OR OLD.evidence_ref IS DISTINCT FROM NEW.evidence_ref
                       OR OLD.recorded_by IS DISTINCT FROM NEW.recorded_by
                       OR OLD.created_at IS DISTINCT FROM NEW.created_at
                       OR OLD.lifecycle_state IS DISTINCT FROM NEW.lifecycle_state THEN
                        RAISE EXCEPTION 'assessment attempt evidence is immutable after submission'
                            USING ERRCODE = 'check_violation';
                    END IF;
                    RETURN NEW;
                END IF;
                IF NEW.lifecycle_state IS DISTINCT FROM 'submitted' THEN
                    RAISE EXCEPTION 'new assessment attempts must be submitted evidence'
                        USING ERRCODE = 'check_violation';
                END IF;
                IF NEW.evidence_ref IS NULL OR char_length(trim(NEW.evidence_ref)) = 0 THEN
                    RAISE EXCEPTION 'assessment attempts require an evidence reference'
                        USING ERRCODE = 'check_violation';
                END IF;
                SELECT e.lifecycle_state, c.lifecycle_state, c.branch_id
                  INTO enrollment_state, class_state, class_branch
                  FROM enrollments e JOIN classes c ON c.id = e.class_id
                 WHERE e.id = NEW.enrollment_id;
                IF enrollment_state IS DISTINCT FROM 'active' OR class_state IS DISTINCT FROM 'active' THEN
                    RAISE EXCEPTION 'assessment attempts require an active enrollment in an active class'
                        USING ERRCODE = 'check_violation';
                END IF;
                IF class_branch IS NULL THEN
                    RAISE EXCEPTION 'assessment attempts require class branch provenance'
                        USING ERRCODE = 'check_violation';
                END IF;
                RETURN NEW;
            END;
            $fn$ LANGUAGE plpgsql;
            SQL);
        DB::statement('CREATE TRIGGER academic_assessment_attempt_guard_trigger BEFORE INSERT OR UPDATE ON assessment_attempts FOR EACH ROW EXECUTE FUNCTION academic_assessment_attempt_guard()');

        DB::statement(<<<'SQL'
            CREATE OR REPLACE FUNCTION academic_assessment_result_guard() RETURNS trigger AS $fn$
            DECLARE
                attempt_state text;
                source_state text;
                source_attempt char(36);
                source_correction boolean;
                correction_score numeric;
                correction_proposer char(36);
                allowed boolean := false;
            BEGIN
                IF TG_OP = 'INSERT' THEN
                    SELECT lifecycle_state INTO attempt_state FROM assessment_attempts WHERE id = NEW.attempt_id;
                    IF attempt_state IS DISTINCT FROM 'submitted' THEN
                        RAISE EXCEPTION 'assessment results require a submitted attempt'
                            USING ERRCODE = 'check_violation';
                    END IF;
                    IF NEW.lifecycle_state = 'scored' AND NEW.corrects_id IS NULL THEN
                        RETURN NEW;
                    END IF;
                    IF NEW.lifecycle_state = 'released' AND NEW.corrects_id IS NOT NULL THEN
                        SELECT lifecycle_state, attempt_id INTO source_state, source_attempt
                          FROM assessment_results WHERE id = NEW.corrects_id;
                        SELECT rc.score, rc.proposed_by, (rc.lifecycle_state = 'proposed')
                          INTO correction_score, correction_proposer, source_correction
                          FROM result_corrections rc
                         WHERE rc.result_id = NEW.corrects_id
                         ORDER BY rc.created_at DESC
                         LIMIT 1;
                        IF source_state IS DISTINCT FROM 'corrected'
                           OR source_attempt IS DISTINCT FROM NEW.attempt_id
                           OR NOT source_correction
                           OR NEW.score IS DISTINCT FROM correction_score
                           OR NEW.scored_by IS DISTINCT FROM correction_proposer
                           OR NEW.correction_reason IS NULL
                           OR char_length(trim(NEW.correction_reason)) = 0 THEN
                            RAISE EXCEPTION 'a replacement result requires an approved correction workflow'
                                USING ERRCODE = 'check_violation';
                        END IF;
                        RETURN NEW;
                    END IF;
                    RAISE EXCEPTION 'new assessment results must be scored, or released replacements must cite a correction'
                        USING ERRCODE = 'check_violation';
                END IF;

                IF OLD.attempt_id IS DISTINCT FROM NEW.attempt_id
                   OR OLD.corrects_id IS DISTINCT FROM NEW.corrects_id
                   OR OLD.score IS DISTINCT FROM NEW.score
                   OR OLD.correction_reason IS DISTINCT FROM NEW.correction_reason
                   OR OLD.scored_by IS DISTINCT FROM NEW.scored_by
                   OR OLD.created_at IS DISTINCT FROM NEW.created_at THEN
                    RAISE EXCEPTION 'assessment result evidence identity is immutable'
                        USING ERRCODE = 'check_violation';
                END IF;
                IF OLD.lifecycle_state = 'scored' AND NEW.lifecycle_state = 'moderated' THEN allowed := true; END IF;
                IF OLD.lifecycle_state = 'moderated' AND NEW.lifecycle_state = 'approved' THEN allowed := true; END IF;
                IF OLD.lifecycle_state = 'approved' AND NEW.lifecycle_state = 'released' THEN allowed := true; END IF;
                IF OLD.lifecycle_state = 'released' AND NEW.lifecycle_state IN ('appealed', 'corrected') THEN allowed := true; END IF;
                IF OLD.lifecycle_state = 'appealed' AND NEW.lifecycle_state = 'corrected' THEN allowed := true; END IF;
                IF OLD.lifecycle_state = NEW.lifecycle_state THEN allowed := true; END IF;
                IF NOT allowed THEN
                    RAISE EXCEPTION 'assessment result lifecycle transition is not allowed: % -> %', OLD.lifecycle_state, NEW.lifecycle_state
                        USING ERRCODE = 'check_violation';
                END IF;
                IF NEW.lifecycle_state = 'moderated' AND (NEW.moderated_by IS NULL OR trim(NEW.moderated_by) = trim(NEW.scored_by)) THEN
                    RAISE EXCEPTION 'moderating an assessment result requires a distinct moderator'
                        USING ERRCODE = 'check_violation';
                END IF;
                IF NEW.lifecycle_state = 'approved' AND (NEW.approved_by IS NULL OR trim(NEW.approved_by) = trim(NEW.scored_by) OR trim(NEW.approved_by) = trim(NEW.moderated_by)) THEN
                    RAISE EXCEPTION 'approving an assessment result requires a distinct approver'
                        USING ERRCODE = 'check_violation';
                END IF;
                IF NEW.lifecycle_state = 'released' AND NEW.released_by IS NULL THEN
                    RAISE EXCEPTION 'releasing an assessment result requires a releaser'
                        USING ERRCODE = 'check_violation';
                END IF;
                IF NEW.lifecycle_state = 'corrected' AND NOT EXISTS (
                    SELECT 1 FROM result_corrections rc
                     WHERE rc.result_id = NEW.id
                       AND rc.lifecycle_state = 'proposed'
                ) THEN
                    RAISE EXCEPTION 'correcting an assessment result requires a proposed correction'
                        USING ERRCODE = 'check_violation';
                END IF;
                RETURN NEW;
            END;
            $fn$ LANGUAGE plpgsql;
            SQL);
        DB::statement('CREATE TRIGGER academic_assessment_result_guard_trigger BEFORE INSERT OR UPDATE ON assessment_results FOR EACH ROW EXECUTE FUNCTION academic_assessment_result_guard()');

        DB::statement(<<<'SQL'
            CREATE OR REPLACE FUNCTION academic_progression_decision_guard() RETURNS trigger AS $fn$
            DECLARE
                class_branch char(36);
                allowed boolean := false;
                supersession boolean := false;
            BEGIN
                SELECT branch_id INTO class_branch FROM classes WHERE id = NEW.class_id;
                IF class_branch IS NULL THEN
                    RAISE EXCEPTION 'progression decisions require class branch provenance'
                        USING ERRCODE = 'check_violation';
                END IF;
                IF TG_OP = 'INSERT' THEN
                    IF NEW.lifecycle_state = 'proposed' THEN
                        RETURN NEW;
                    END IF;
                    IF NEW.lifecycle_state = 'approved' AND NEW.superseded_by_id IS NULL
                       AND NEW.reviewed_by IS NOT NULL AND NEW.approved_by IS NOT NULL
                       AND trim(NEW.proposed_by) <> trim(NEW.approved_by)
                       AND trim(NEW.reviewed_by) <> trim(NEW.approved_by)
                       AND EXISTS (SELECT 1 FROM progression_decisions p WHERE p.superseded_by_id = NEW.id AND p.lifecycle_state = 'superseded') THEN
                        RETURN NEW;
                    END IF;
                    RAISE EXCEPTION 'new progression decisions must be proposed or be a fully signed appeal successor'
                        USING ERRCODE = 'check_violation';
                END IF;
                IF OLD.student_id IS DISTINCT FROM NEW.student_id
                   OR OLD.class_id IS DISTINCT FROM NEW.class_id
                   OR OLD.outcome IS DISTINCT FROM NEW.outcome
                   OR OLD.reason IS DISTINCT FROM NEW.reason
                   OR OLD.proposed_by IS DISTINCT FROM NEW.proposed_by
                   OR (OLD.appeal_reviewed_by IS DISTINCT FROM NEW.appeal_reviewed_by
                       AND OLD.lifecycle_state <> 'approved'
                       AND OLD.lifecycle_state <> 'rejected')
                   OR OLD.created_at IS DISTINCT FROM NEW.created_at THEN
                    RAISE EXCEPTION 'progression decision identity is immutable'
                        USING ERRCODE = 'check_violation';
                END IF;
                IF OLD.lifecycle_state = 'proposed' AND NEW.lifecycle_state = 'reviewed' THEN allowed := true; END IF;
                IF OLD.lifecycle_state = 'reviewed' AND NEW.lifecycle_state IN ('approved', 'rejected') THEN allowed := true; END IF;
                IF OLD.lifecycle_state IN ('approved', 'rejected') AND NEW.lifecycle_state IN ('appealed', 'superseded') THEN allowed := true; END IF;
                IF OLD.lifecycle_state = 'appealed' AND NEW.lifecycle_state = 'superseded' THEN allowed := true; END IF;
                IF OLD.lifecycle_state = NEW.lifecycle_state THEN allowed := true; END IF;
                IF NOT allowed THEN
                    RAISE EXCEPTION 'progression decision lifecycle transition is not allowed: % -> %', OLD.lifecycle_state, NEW.lifecycle_state
                        USING ERRCODE = 'check_violation';
                END IF;
                IF NEW.lifecycle_state = 'reviewed' AND (NEW.reviewed_by IS NULL OR trim(NEW.reviewed_by) = trim(NEW.proposed_by)) THEN
                    RAISE EXCEPTION 'progression review requires a distinct reviewer'
                        USING ERRCODE = 'check_violation';
                END IF;
                IF NEW.lifecycle_state = 'appealed' AND (NEW.appeal_reviewed_by IS NULL OR trim(NEW.appeal_reviewed_by) = trim(NEW.proposed_by) OR trim(NEW.appeal_reviewed_by) = trim(COALESCE(NEW.approved_by, ''))) THEN
                    RAISE EXCEPTION 'progression appeal review requires a distinct reviewer'
                        USING ERRCODE = 'check_violation';
                END IF;
                IF NEW.lifecycle_state IN ('approved', 'rejected') AND (NEW.approved_by IS NULL OR trim(NEW.approved_by) = trim(NEW.proposed_by) OR trim(NEW.approved_by) = trim(NEW.reviewed_by)) THEN
                    RAISE EXCEPTION 'progression approval or rejection requires a distinct approver'
                        USING ERRCODE = 'check_violation';
                END IF;
                IF NEW.lifecycle_state = 'superseded' AND NEW.superseded_by_id IS NULL THEN
                    RAISE EXCEPTION 'a superseded progression decision requires its successor'
                        USING ERRCODE = 'check_violation';
                END IF;
                RETURN NEW;
            END;
            $fn$ LANGUAGE plpgsql;
            SQL);
        DB::statement('CREATE TRIGGER academic_progression_decision_guard_trigger BEFORE INSERT OR UPDATE ON progression_decisions FOR EACH ROW EXECUTE FUNCTION academic_progression_decision_guard()');

        DB::statement(<<<'SQL'
            CREATE OR REPLACE FUNCTION academic_offering_capacity_guard() RETURNS trigger AS $fn$
            DECLARE
                claimed integer;
            BEGIN
                IF NEW.capacity <= 0 THEN
                    RAISE EXCEPTION 'offering capacity must be positive'
                        USING ERRCODE = 'check_violation';
                END IF;
                IF TG_OP = 'UPDATE' AND NEW.capacity IS DISTINCT FROM OLD.capacity THEN
                    SELECT count(*) INTO claimed
                      FROM enrollments e
                     WHERE e.offering_id = NEW.id
                       AND e.lifecycle_state IN ('requested', 'active', 'frozen');
                    IF NEW.capacity < claimed THEN
                        RAISE EXCEPTION 'offering capacity cannot fall below % live seat claim(s)', claimed
                            USING ERRCODE = 'check_violation';
                    END IF;
                END IF;
                RETURN NEW;
            END;
            $fn$ LANGUAGE plpgsql;
            SQL);
        DB::statement('CREATE TRIGGER academic_offering_capacity_guard_trigger BEFORE INSERT OR UPDATE OF capacity ON offerings FOR EACH ROW EXECUTE FUNCTION academic_offering_capacity_guard()');

        DB::statement(<<<'SQL'
            CREATE OR REPLACE FUNCTION academic_teacher_assignment_temporal_guard() RETURNS trigger AS $fn$
            DECLARE
                overlap integer;
            BEGIN
                IF NEW.effective_to IS NOT NULL AND NEW.effective_to <= NEW.effective_from THEN
                    RAISE EXCEPTION 'teacher assignment effective window is invalid'
                        USING ERRCODE = 'check_violation';
                END IF;
                SELECT count(*) INTO overlap
                  FROM teacher_assignments ta
                 WHERE ta.class_id = NEW.class_id
                   AND ta.teacher_person_id = NEW.teacher_person_id
                   AND ta.id <> NEW.id
                   AND ta.effective_from < COALESCE(NEW.effective_to, 'infinity'::date)
                   AND COALESCE(ta.effective_to, 'infinity'::date) > NEW.effective_from;
                IF overlap > 0 THEN
                    RAISE EXCEPTION 'teacher assignment windows may not overlap for one class and teacher'
                        USING ERRCODE = 'exclusion_violation';
                END IF;
                RETURN NEW;
            END;
            $fn$ LANGUAGE plpgsql;
            SQL);
        DB::statement('CREATE TRIGGER academic_teacher_assignment_temporal_guard_trigger BEFORE INSERT OR UPDATE ON teacher_assignments FOR EACH ROW EXECUTE FUNCTION academic_teacher_assignment_temporal_guard()');
        DB::statement('ALTER TABLE academic_appeals ALTER COLUMN student_id DROP NOT NULL');
        DB::statement('ALTER TABLE academic_appeals DROP CONSTRAINT IF EXISTS academic_appeals_subject_type_check');
        DB::statement("ALTER TABLE academic_appeals ADD CONSTRAINT academic_appeals_subject_type_check CHECK (subject_type IN ('assessment_result','progression_decision','placement_profile'))");
        DB::statement("CREATE UNIQUE INDEX academic_appeals_one_open_subject ON academic_appeals (subject_type, subject_id) WHERE lifecycle_state NOT IN ('rejected', 'closed')");

        DB::statement(<<<'SQL'
            CREATE OR REPLACE FUNCTION academic_graduation_decision_guard() RETURNS trigger AS $fn$
            DECLARE
                allowed boolean := false;
            BEGIN
                IF TG_OP = 'INSERT' THEN
                    IF NEW.lifecycle_state IS DISTINCT FROM 'proposed'
                       OR NEW.proposed_by IS NULL
                       OR NEW.basis IS NULL
                       OR char_length(trim(NEW.basis)) = 0 THEN
                        RAISE EXCEPTION 'new graduation decisions must be proposed with a basis'
                            USING ERRCODE = 'check_violation';
                    END IF;
                    RETURN NEW;
                END IF;
                IF OLD.student_id IS DISTINCT FROM NEW.student_id
                   OR OLD.program_version_id IS DISTINCT FROM NEW.program_version_id
                   OR OLD.outcome IS DISTINCT FROM NEW.outcome
                   OR OLD.basis IS DISTINCT FROM NEW.basis
                   OR OLD.proposed_by IS DISTINCT FROM NEW.proposed_by
                   OR OLD.created_at IS DISTINCT FROM NEW.created_at THEN
                    RAISE EXCEPTION 'graduation decision identity is immutable'
                        USING ERRCODE = 'check_violation';
                END IF;
                IF OLD.lifecycle_state = 'proposed' AND NEW.lifecycle_state = 'reviewed' THEN allowed := true; END IF;
                IF OLD.lifecycle_state = 'reviewed' AND NEW.lifecycle_state IN ('approved', 'rejected') THEN allowed := true; END IF;
                IF OLD.lifecycle_state = NEW.lifecycle_state THEN allowed := true; END IF;
                IF NOT allowed THEN
                    RAISE EXCEPTION 'graduation decision lifecycle transition is not allowed: % -> %', OLD.lifecycle_state, NEW.lifecycle_state
                        USING ERRCODE = 'check_violation';
                END IF;
                IF OLD.reviewed_by IS DISTINCT FROM NEW.reviewed_by
                   AND OLD.lifecycle_state <> 'proposed' THEN
                    RAISE EXCEPTION 'graduation reviewer identity is immutable'
                        USING ERRCODE = 'check_violation';
                END IF;
                IF OLD.approved_by IS DISTINCT FROM NEW.approved_by
                   AND OLD.lifecycle_state <> 'reviewed' THEN
                    RAISE EXCEPTION 'graduation approver identity is immutable'
                        USING ERRCODE = 'check_violation';
                END IF;
                IF NEW.lifecycle_state = 'reviewed'
                   AND (NEW.reviewed_by IS NULL OR trim(NEW.reviewed_by) = trim(NEW.proposed_by)) THEN
                    RAISE EXCEPTION 'graduation review requires a distinct reviewer'
                        USING ERRCODE = 'check_violation';
                END IF;
                IF NEW.lifecycle_state IN ('approved', 'rejected')
                   AND (NEW.approved_by IS NULL OR trim(NEW.approved_by) = trim(NEW.proposed_by) OR trim(NEW.approved_by) = trim(NEW.reviewed_by)) THEN
                    RAISE EXCEPTION 'graduation approval or rejection requires a distinct approver'
                        USING ERRCODE = 'check_violation';
                END IF;
                RETURN NEW;
            END;
            $fn$ LANGUAGE plpgsql;
            SQL);
        DB::statement('CREATE TRIGGER academic_graduation_decision_guard_trigger BEFORE INSERT OR UPDATE ON graduation_decisions FOR EACH ROW EXECUTE FUNCTION academic_graduation_decision_guard()');

        DB::statement(<<<'SQL'
            CREATE OR REPLACE FUNCTION academic_appeal_authority_guard() RETURNS trigger AS $fn$
            DECLARE
                allowed boolean := false;
            BEGIN
                IF TG_OP = 'INSERT' THEN
                    IF NEW.lifecycle_state IS DISTINCT FROM 'open'
                       OR NEW.reason IS NULL OR char_length(trim(NEW.reason)) = 0 THEN
                        RAISE EXCEPTION 'new academic appeals must be open and carry a reason'
                            USING ERRCODE = 'check_violation';
                    END IF;
                    RETURN NEW;
                END IF;
                IF OLD.student_id IS DISTINCT FROM NEW.student_id
                   OR OLD.subject_type IS DISTINCT FROM NEW.subject_type
                   OR OLD.subject_id IS DISTINCT FROM NEW.subject_id
                   OR OLD.reason IS DISTINCT FROM NEW.reason
                   OR OLD.created_at IS DISTINCT FROM NEW.created_at THEN
                    RAISE EXCEPTION 'academic appeal subject identity is immutable'
                        USING ERRCODE = 'check_violation';
                END IF;
                IF OLD.lifecycle_state = 'open' AND NEW.lifecycle_state = 'assigned' THEN allowed := true; END IF;
                IF OLD.lifecycle_state = 'assigned' AND NEW.lifecycle_state IN ('investigating', 'escalated') THEN allowed := true; END IF;
                IF OLD.lifecycle_state = 'investigating' AND NEW.lifecycle_state IN ('resolved', 'rejected', 'escalated') THEN allowed := true; END IF;
                IF OLD.lifecycle_state = 'escalated' AND NEW.lifecycle_state = 'assigned' THEN allowed := true; END IF;
                IF OLD.lifecycle_state IN ('resolved', 'rejected') AND NEW.lifecycle_state = 'closed' THEN allowed := true; END IF;
                IF OLD.lifecycle_state = NEW.lifecycle_state THEN allowed := true; END IF;
                IF NOT allowed THEN
                    RAISE EXCEPTION 'academic appeal lifecycle transition is not allowed: % -> %', OLD.lifecycle_state, NEW.lifecycle_state
                        USING ERRCODE = 'check_violation';
                END IF;
                IF OLD.decided_by IS DISTINCT FROM NEW.decided_by
                   AND OLD.lifecycle_state <> 'investigating' THEN
                    RAISE EXCEPTION 'academic appeal decision identity is immutable'
                        USING ERRCODE = 'check_violation';
                END IF;
                IF (OLD.outcome IS DISTINCT FROM NEW.outcome OR OLD.outcome_evidence IS DISTINCT FROM NEW.outcome_evidence)
                   AND OLD.lifecycle_state NOT IN ('investigating') THEN
                    RAISE EXCEPTION 'academic appeal outcome is immutable after decision'
                        USING ERRCODE = 'check_violation';
                END IF;
                IF NEW.lifecycle_state IN ('resolved', 'rejected')
                   AND (NEW.outcome IS NULL OR char_length(trim(NEW.outcome)) = 0
                        OR NEW.outcome_evidence IS NULL OR char_length(trim(NEW.outcome_evidence)) = 0
                        OR NEW.decided_by IS NULL) THEN
                    RAISE EXCEPTION 'a decided academic appeal requires outcome, evidence and a decision-maker'
                        USING ERRCODE = 'check_violation';
                END IF;
                RETURN NEW;
            END;
            $fn$ LANGUAGE plpgsql;
            SQL);
        DB::statement('CREATE TRIGGER academic_appeal_authority_guard_trigger BEFORE INSERT OR UPDATE ON academic_appeals FOR EACH ROW EXECUTE FUNCTION academic_appeal_authority_guard()');
    }

    public function down(): void
    {
        DB::statement(<<<'SQL'
            CREATE OR REPLACE FUNCTION offering_requires_available_branch() RETURNS trigger AS $fn$
            DECLARE
                period_state text;
            BEGIN
                SELECT lifecycle_state INTO period_state
                  FROM academic_periods WHERE id = NEW.academic_period_id;
                IF period_state IS NULL OR period_state <> 'published' THEN
                    RAISE EXCEPTION 'offering term must be published/open'
                        USING ERRCODE = 'check_violation';
                END IF;
                IF NOT EXISTS (
                    SELECT 1 FROM branch_availabilities ba
                     WHERE ba.branch_id = NEW.branch_id
                       AND ba.program_version_level_id = NEW.program_version_level_id
                       AND ba.academic_period_id = NEW.academic_period_id
                       AND ba.lifecycle_state = 'active'
                ) THEN
                    RAISE EXCEPTION 'offering requires an active branch availability for the branch, level and term'
                        USING ERRCODE = 'check_violation';
                END IF;
                RETURN NEW;
            END;
            $fn$ LANGUAGE plpgsql;
            SQL);
        DB::statement('DROP TRIGGER IF EXISTS academic_offering_reference_guard_trigger ON offerings');
        DB::statement('DROP TRIGGER IF EXISTS academic_availability_reference_guard_trigger ON branch_availabilities');
        DB::statement('DROP FUNCTION IF EXISTS academic_offering_reference_guard()');
        DB::statement('DROP TRIGGER IF EXISTS academic_class_scope_guard_trigger ON classes');
        DB::statement('DROP TRIGGER IF EXISTS academic_offering_scope_guard_trigger ON offerings');
        DB::statement('DROP TRIGGER IF EXISTS academic_availability_scope_guard_trigger ON branch_availabilities');
        DB::statement('DROP FUNCTION IF EXISTS academic_scope_branch_guard()');
        DB::statement('DROP TRIGGER IF EXISTS academic_progression_decision_guard_trigger ON progression_decisions');
        DB::statement('DROP FUNCTION IF EXISTS academic_progression_decision_guard()');
        DB::statement('DROP TRIGGER IF EXISTS academic_assessment_result_guard_trigger ON assessment_results');
        DB::statement('DROP FUNCTION IF EXISTS academic_assessment_result_guard()');
        DB::statement('DROP TRIGGER IF EXISTS academic_assessment_attempt_guard_trigger ON assessment_attempts');
        DB::statement('DROP FUNCTION IF EXISTS academic_assessment_attempt_guard()');
        DB::statement('DROP TRIGGER IF EXISTS academic_teacher_assignment_temporal_guard_trigger ON teacher_assignments');
        DB::statement('DROP FUNCTION IF EXISTS academic_teacher_assignment_temporal_guard()');
        DB::statement('DROP TRIGGER IF EXISTS academic_attendance_reference_guard_trigger ON attendance_facts');
        DB::statement('DROP FUNCTION IF EXISTS academic_attendance_reference_guard()');
        DB::statement('DROP TRIGGER IF EXISTS academic_session_identity_guard_trigger ON class_sessions');
        DB::statement('DROP FUNCTION IF EXISTS academic_session_identity_guard()');
        DB::statement('DROP TRIGGER IF EXISTS academic_session_scope_guard_trigger ON class_sessions');
        DB::statement('DROP FUNCTION IF EXISTS academic_session_scope_guard()');
        DB::statement('DROP TRIGGER IF EXISTS academic_waitlist_reference_guard_trigger ON class_waitlist_entries');
        DB::statement('DROP FUNCTION IF EXISTS academic_waitlist_reference_guard()');
        DB::statement('DROP TRIGGER IF EXISTS academic_offering_capacity_guard_trigger ON offerings');
        DB::statement('DROP FUNCTION IF EXISTS academic_offering_capacity_guard()');
        DB::statement('DROP TRIGGER IF EXISTS academic_enrollment_capacity_guard_trigger ON enrollments');
        DB::statement('DROP FUNCTION IF EXISTS academic_enrollment_capacity_guard()');
        DB::statement('DROP TRIGGER IF EXISTS academic_class_lifecycle_guard_trigger ON classes');
        DB::statement('DROP FUNCTION IF EXISTS academic_class_lifecycle_guard()');
        DB::statement('DROP TRIGGER IF EXISTS academic_class_authority_guard_trigger ON classes');
        DB::statement('DROP FUNCTION IF EXISTS academic_class_authority_guard()');
        DB::statement('DROP TRIGGER IF EXISTS academic_offering_identity_guard_trigger ON offerings');
        DB::statement('DROP FUNCTION IF EXISTS academic_offering_identity_guard()');
        DB::statement('DROP TRIGGER IF EXISTS academic_period_authority_guard_trigger ON academic_periods');
        DB::statement('DROP FUNCTION IF EXISTS academic_period_authority_guard()');
        DB::statement('DROP TRIGGER IF EXISTS academic_appeal_authority_guard_trigger ON academic_appeals');
        DB::statement('DROP FUNCTION IF EXISTS academic_appeal_authority_guard()');
        DB::statement('DROP TRIGGER IF EXISTS academic_graduation_decision_guard_trigger ON graduation_decisions');
        DB::statement('DROP FUNCTION IF EXISTS academic_graduation_decision_guard()');
        DB::statement('DROP INDEX IF EXISTS academic_appeals_one_open_subject');
        DB::statement('ALTER TABLE academic_appeals DROP CONSTRAINT IF EXISTS academic_appeals_subject_type_check');
        DB::statement("ALTER TABLE academic_appeals ADD CONSTRAINT academic_appeals_subject_type_check CHECK (subject_type IN ('assessment_result','progression_decision'))");
        DB::statement('ALTER TABLE academic_appeals ALTER COLUMN student_id SET NOT NULL');
        DB::statement('DROP INDEX IF EXISTS classes_offering_lifecycle_index');
        Schema::table('progression_decisions', function (Blueprint $table): void {
            $table->dropColumn('appeal_reviewed_by');
        });
        Schema::table('classes', function (Blueprint $table): void {
            $table->dropForeign(['offering_id']);
            $table->dropColumn('offering_id');
        });
    }
};
