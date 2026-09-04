<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Schema;

/**
 * Academic offering lifecycle + enroll-to-offering + class waitlist.
 *
 * - BranchAvailability gains an explicit active|closed lifecycle; closing is
 *   allowed only while no related offering is still open.
 * - Offering gains open|closed|cancelled|completed. The existing packaging
 *   trigger is relaxed so lifecycle-state updates do NOT require the term to
 *   remain open; the (branch x level x term) triple remains immutable.
 * - Offerings can be resized only when the new capacity is >= the number of
 *   active seats.
 * - Enrollments may target an offering. When they do, the offering must be
 *   open and must exactly match the class's period and level. The offering on
 *   an enrollment row is immutable; activation also counts against the
 *   offering capacity.
 * - class_waitlist_entries records ordered waitlist requests per class; a
 *   student holds at most one open entry per class, positions are unique
 *   among open entries, and promotion creates a normal requested enrollment.
 */
return new class extends Migration
{
    public function up(): void
    {
        DB::statement("ALTER TABLE branch_availabilities ADD CONSTRAINT branch_availabilities_lifecycle_check CHECK (lifecycle_state IN ('active','closed'))");
        DB::statement("ALTER TABLE offerings ADD CONSTRAINT offerings_lifecycle_check CHECK (lifecycle_state IN ('open','closed','cancelled','completed'))");

        // Relax the packaging trigger so lifecycle-state updates (close,
        // cancel, complete, resize) do not require an open term. The core
        // invariant — the (branch x level x term) triple must have an active
        // availability and an open term when it is first packaged — remains.
        DB::statement(<<<'SQL'
            CREATE OR REPLACE FUNCTION offering_requires_available_branch() RETURNS trigger AS $fn$
            DECLARE
                period_state text;
            BEGIN
                IF TG_OP = 'INSERT' OR NEW.branch_id IS DISTINCT FROM OLD.branch_id
                   OR NEW.program_version_level_id IS DISTINCT FROM OLD.program_version_level_id
                   OR NEW.academic_period_id IS DISTINCT FROM OLD.academic_period_id THEN
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
                END IF;
                RETURN NEW;
            END;
            $fn$ LANGUAGE plpgsql;
            SQL);

        DB::statement(<<<'SQL'
            CREATE OR REPLACE FUNCTION branch_availabilities_lifecycle_guard() RETURNS trigger AS $fn$
            DECLARE
                period_state text;
                level_state text;
                open_offerings integer;
            BEGIN
                IF NEW.lifecycle_state = 'active' AND OLD.lifecycle_state = 'closed' THEN
                    SELECT lifecycle_state INTO period_state FROM academic_periods WHERE id = NEW.academic_period_id;
                    IF period_state IS NULL OR period_state <> 'published' THEN
                        RAISE EXCEPTION 'availability cannot reopen while its term is not open'
                            USING ERRCODE = 'check_violation';
                    END IF;
                    SELECT lifecycle_state INTO level_state FROM program_version_levels WHERE id = NEW.program_version_level_id;
                    IF level_state IS NULL OR level_state <> 'active' THEN
                        RAISE EXCEPTION 'availability cannot reopen while its level is not active'
                            USING ERRCODE = 'check_violation';
                    END IF;
                END IF;
                IF NEW.lifecycle_state = 'closed' AND OLD.lifecycle_state = 'active' THEN
                    SELECT count(*) INTO open_offerings
                      FROM offerings o
                     WHERE o.branch_id = NEW.branch_id
                       AND o.program_version_level_id = NEW.program_version_level_id
                       AND o.academic_period_id = NEW.academic_period_id
                       AND o.lifecycle_state = 'open';
                    IF open_offerings > 0 THEN
                        RAISE EXCEPTION 'availability cannot close while % open offering(s) reference it', open_offerings
                            USING ERRCODE = 'check_violation';
                    END IF;
                END IF;
                RETURN NEW;
            END;
            $fn$ LANGUAGE plpgsql;
            SQL);
        DB::statement('DROP TRIGGER IF EXISTS branch_availabilities_lifecycle_guard_trigger ON branch_availabilities');
        DB::statement('CREATE TRIGGER branch_availabilities_lifecycle_guard_trigger BEFORE UPDATE ON branch_availabilities FOR EACH ROW EXECUTE FUNCTION branch_availabilities_lifecycle_guard()');

        DB::statement(<<<'SQL'
            CREATE OR REPLACE FUNCTION offerings_lifecycle_guard() RETURNS trigger AS $fn$
            DECLARE
                open_seats integer;
                active_seats integer;
            BEGIN
                IF NEW.capacity IS DISTINCT FROM OLD.capacity THEN
                    SELECT count(*) INTO active_seats
                      FROM enrollments e
                     WHERE e.offering_id = NEW.id
                       AND e.lifecycle_state = 'active';
                    IF NEW.capacity < active_seats THEN
                        RAISE EXCEPTION 'offering capacity cannot fall below its active seat count (%)', active_seats
                            USING ERRCODE = 'check_violation';
                    END IF;
                END IF;
                IF NEW.lifecycle_state IN ('cancelled', 'completed') AND OLD.lifecycle_state NOT IN ('cancelled', 'completed') THEN
                    SELECT count(*) INTO open_seats
                      FROM enrollments e
                     WHERE e.offering_id = NEW.id
                       AND e.lifecycle_state IN ('requested', 'active', 'frozen');
                    IF open_seats > 0 THEN
                        RAISE EXCEPTION 'offering cannot be % while % enrollment seat(s) remain open', NEW.lifecycle_state, open_seats
                            USING ERRCODE = 'check_violation';
                    END IF;
                END IF;
                IF NEW.lifecycle_state = 'open' AND OLD.lifecycle_state IN ('cancelled', 'completed') THEN
                    RAISE EXCEPTION 'a cancelled or completed offering cannot be reopened'
                        USING ERRCODE = 'check_violation';
                END IF;
                RETURN NEW;
            END;
            $fn$ LANGUAGE plpgsql;
            SQL);
        DB::statement('DROP TRIGGER IF EXISTS offerings_lifecycle_guard_trigger ON offerings');
        DB::statement('CREATE TRIGGER offerings_lifecycle_guard_trigger BEFORE UPDATE ON offerings FOR EACH ROW EXECUTE FUNCTION offerings_lifecycle_guard()');

        DB::statement(<<<'SQL'
            CREATE OR REPLACE FUNCTION enrollments_offering_guard() RETURNS trigger AS $fn$
            DECLARE
                offering_state text;
                offering_period char(36);
                offering_level char(36);
                class_period char(36);
                class_level char(36);
                offering_capacity integer;
                offering_active integer;
            BEGIN
                IF OLD.offering_id IS NOT NULL AND NEW.offering_id IS DISTINCT FROM OLD.offering_id THEN
                    RAISE EXCEPTION 'the offering on an enrollment seat is immutable (a transfer opens a new seat)'
                        USING ERRCODE = 'check_violation';
                END IF;

                IF NEW.offering_id IS NULL THEN
                    RETURN NEW;
                END IF;

                SELECT lifecycle_state, academic_period_id, program_version_level_id, capacity
                  INTO offering_state, offering_period, offering_level, offering_capacity
                  FROM offerings WHERE id = NEW.offering_id;
                IF offering_state IS NULL THEN
                    RAISE EXCEPTION 'enrollment references an unknown offering'
                        USING ERRCODE = 'foreign_key_violation';
                END IF;
                IF TG_OP = 'INSERT' AND offering_state <> 'open' THEN
                    RAISE EXCEPTION 'a new enrollment may target only an open offering (offering state: %)', offering_state
                        USING ERRCODE = 'check_violation';
                END IF;

                SELECT period_id, program_version_level_id INTO class_period, class_level
                  FROM classes WHERE id = NEW.class_id;
                IF offering_period IS DISTINCT FROM class_period
                   OR offering_level IS DISTINCT FROM class_level THEN
                    RAISE EXCEPTION 'the enrollment offering must match the class period and level'
                        USING ERRCODE = 'check_violation';
                END IF;

                IF NEW.lifecycle_state = 'active' AND OLD.lifecycle_state <> 'active' THEN
                    SELECT count(*) INTO offering_active
                      FROM enrollments e
                     WHERE e.offering_id = NEW.offering_id
                       AND e.lifecycle_state = 'active'
                       AND e.id <> NEW.id;
                    IF offering_active >= offering_capacity THEN
                        RAISE EXCEPTION 'offering % is full (%/% active seats)', NEW.offering_id, offering_active, offering_capacity
                            USING ERRCODE = 'check_violation';
                    END IF;
                END IF;

                RETURN NEW;
            END;
            $fn$ LANGUAGE plpgsql;
            SQL);
        DB::statement('DROP TRIGGER IF EXISTS enrollments_offering_guard_trigger ON enrollments');
        DB::statement('CREATE TRIGGER enrollments_offering_guard_trigger BEFORE INSERT OR UPDATE ON enrollments FOR EACH ROW EXECUTE FUNCTION enrollments_offering_guard()');

        Schema::create('class_waitlist_entries', function (Blueprint $table): void {
            $table->char('id', 36)->primary();
            $table->char('class_id', 36);
            $table->char('student_id', 36);
            $table->char('offering_id', 36)->nullable();
            $table->integer('position');
            $table->string('lifecycle_state');
            $table->char('joined_by', 36);
            $table->timestamps();
            $table->foreign('class_id')->references('id')->on('classes');
            $table->foreign('student_id')->references('id')->on('students');
            $table->foreign('offering_id')->references('id')->on('offerings');
        });
        DB::statement("ALTER TABLE class_waitlist_entries ADD CONSTRAINT class_waitlist_entries_lifecycle_check CHECK (lifecycle_state IN ('waiting','offered','enrolled','withdrawn','expired'))");
        DB::statement('CREATE UNIQUE INDEX class_waitlist_open_student ON class_waitlist_entries (class_id, student_id) WHERE lifecycle_state IN (\'waiting\', \'offered\')');
        DB::statement('CREATE UNIQUE INDEX class_waitlist_open_position ON class_waitlist_entries (class_id, position) WHERE lifecycle_state IN (\'waiting\', \'offered\')');

        DB::statement(<<<'SQL'
            CREATE OR REPLACE FUNCTION class_waitlist_entries_guard() RETURNS trigger AS $fn$
            DECLARE
                student_state text;
                class_state text;
                offering_state text;
                class_period char(36);
                class_level char(36);
                offering_period char(36);
                offering_level char(36);
            BEGIN
                IF NEW.position < 1 THEN
                    RAISE EXCEPTION 'a waitlist position must be at least 1'
                        USING ERRCODE = 'check_violation';
                END IF;

                SELECT s.status INTO student_state
                  FROM student_statuses s
                 WHERE s.student_id = NEW.student_id
                 ORDER BY s.seq DESC
                 LIMIT 1
                 FOR UPDATE;
                IF student_state IS DISTINCT FROM 'active' THEN
                    RAISE EXCEPTION 'a waitlist requires a currently active student (latest status: %)', student_state
                        USING ERRCODE = 'check_violation';
                END IF;

                SELECT lifecycle_state, period_id, program_version_level_id INTO class_state, class_period, class_level
                  FROM classes c WHERE c.id = NEW.class_id FOR UPDATE;
                IF class_state IS NULL THEN
                    RAISE EXCEPTION 'a waitlist requires an existing class'
                        USING ERRCODE = 'foreign_key_violation';
                END IF;
                IF class_state <> 'active' THEN
                    RAISE EXCEPTION 'a waitlist requires an active class (class state: %)', class_state
                        USING ERRCODE = 'check_violation';
                END IF;

                IF NEW.offering_id IS NOT NULL THEN
                    SELECT lifecycle_state, academic_period_id, program_version_level_id
                      INTO offering_state, offering_period, offering_level
                      FROM offerings WHERE id = NEW.offering_id;
                    IF offering_state IS DISTINCT FROM 'open' THEN
                        RAISE EXCEPTION 'a waitlist may target only an open offering (offering state: %)', offering_state
                            USING ERRCODE = 'check_violation';
                    END IF;
                    IF offering_period IS DISTINCT FROM class_period
                       OR offering_level IS DISTINCT FROM class_level THEN
                        RAISE EXCEPTION 'the waitlist offering must match the class period and level'
                            USING ERRCODE = 'check_violation';
                    END IF;
                END IF;
                RETURN NEW;
            END;
            $fn$ LANGUAGE plpgsql;
            SQL);
        DB::statement('DROP TRIGGER IF EXISTS class_waitlist_entries_guard_trigger ON class_waitlist_entries');
        DB::statement('CREATE TRIGGER class_waitlist_entries_guard_trigger BEFORE INSERT ON class_waitlist_entries FOR EACH ROW EXECUTE FUNCTION class_waitlist_entries_guard()');

        DB::statement(<<<'SQL'
            CREATE OR REPLACE FUNCTION class_waitlist_entries_update_guard() RETURNS trigger AS $fn$
            BEGIN
                IF OLD.class_id IS DISTINCT FROM NEW.class_id
                   OR OLD.student_id IS DISTINCT FROM NEW.student_id
                   OR OLD.position IS DISTINCT FROM NEW.position
                   OR OLD.offering_id IS DISTINCT FROM NEW.offering_id THEN
                    RAISE EXCEPTION 'a waitlist entry identity and position are immutable'
                        USING ERRCODE = 'check_violation';
                END IF;
                IF OLD.lifecycle_state = 'enrolled' THEN
                    RAISE EXCEPTION 'an enrolled waitlist entry is terminal'
                        USING ERRCODE = 'check_violation';
                END IF;
                IF OLD.lifecycle_state IN ('withdrawn', 'expired') THEN
                    RAISE EXCEPTION 'a withdrawn or expired waitlist entry is terminal'
                        USING ERRCODE = 'check_violation';
                END IF;
                IF NEW.lifecycle_state NOT IN ('waiting', 'offered', 'withdrawn', 'expired', 'enrolled') THEN
                    RAISE EXCEPTION 'unknown waitlist lifecycle state %', NEW.lifecycle_state
                        USING ERRCODE = 'check_violation';
                END IF;
                IF OLD.lifecycle_state = 'offered' AND NEW.lifecycle_state <> 'enrolled' THEN
                    RAISE EXCEPTION 'an offered waitlist entry can move only to enrolled'
                        USING ERRCODE = 'check_violation';
                END IF;
                RETURN NEW;
            END;
            $fn$ LANGUAGE plpgsql;
            SQL);
        DB::statement('DROP TRIGGER IF EXISTS class_waitlist_entries_update_guard_trigger ON class_waitlist_entries');
        DB::statement('CREATE TRIGGER class_waitlist_entries_update_guard_trigger BEFORE UPDATE ON class_waitlist_entries FOR EACH ROW EXECUTE FUNCTION class_waitlist_entries_update_guard()');
    }

    public function down(): void
    {
        DB::statement('DROP TRIGGER IF EXISTS class_waitlist_entries_update_guard_trigger ON class_waitlist_entries');
        DB::statement('DROP FUNCTION IF EXISTS class_waitlist_entries_update_guard()');
        DB::statement('DROP TRIGGER IF EXISTS class_waitlist_entries_guard_trigger ON class_waitlist_entries');
        DB::statement('DROP FUNCTION IF EXISTS class_waitlist_entries_guard()');
        Schema::dropIfExists('class_waitlist_entries');

        DB::statement('DROP TRIGGER IF EXISTS enrollments_offering_guard_trigger ON enrollments');
        DB::statement('DROP FUNCTION IF EXISTS enrollments_offering_guard()');

        DB::statement('DROP TRIGGER IF EXISTS offerings_lifecycle_guard_trigger ON offerings');
        DB::statement('DROP FUNCTION IF EXISTS offerings_lifecycle_guard()');
        DB::statement('DROP TRIGGER IF EXISTS branch_availabilities_lifecycle_guard_trigger ON branch_availabilities');
        DB::statement('DROP FUNCTION IF EXISTS branch_availabilities_lifecycle_guard()');

        // Restore the original packaging trigger that requires an open term on
        // every offering insert/update, as migration 000123 left it.
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

        DB::statement('ALTER TABLE offerings DROP CONSTRAINT IF EXISTS offerings_lifecycle_check');
        DB::statement('ALTER TABLE branch_availabilities DROP CONSTRAINT IF EXISTS branch_availabilities_lifecycle_check');
    }
};
