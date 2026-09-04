<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Schema;

/**
 * Academic rooms, class sections and the room/timetable scheduling surface.
 *
 * - academic_rooms: branch-owned physical resource with an
 *   available|maintenance|retired lifecycle and capacity.
 * - class_sections: named operational delivery group inside a class with a
 *   planned|open|closed|cancelled|archived lifecycle. Seat accounting stays
 *   at class/offering level.
 * - class_sessions gains optional room_id/section_id. Scheduling guards
 *   accept only available rooms and open sections of the same class, reject
 *   room and class/section time overlaps, and keep the timetable identity of
 *   an existing session immutable.
 */
return new class extends Migration
{
    public function up(): void
    {
        Schema::create('academic_rooms', function (Blueprint $table): void {
            $table->char('id', 36)->primary();
            $table->char('branch_id', 36);
            $table->string('name');
            $table->string('code');
            $table->integer('capacity');
            $table->string('room_type');
            $table->string('lifecycle_state');
            $table->timestamps();
            $table->foreign('branch_id')->references('id')->on('branches');
        });
        DB::statement('CREATE UNIQUE INDEX academic_rooms_branch_code_unique ON academic_rooms (branch_id, code)');
        DB::statement('ALTER TABLE academic_rooms ADD CONSTRAINT academic_rooms_capacity_check CHECK (capacity > 0)');
        DB::statement("ALTER TABLE academic_rooms ADD CONSTRAINT academic_rooms_lifecycle_check CHECK (lifecycle_state IN ('available','maintenance','retired'))");
        DB::statement("ALTER TABLE academic_rooms ADD CONSTRAINT academic_rooms_type_check CHECK (room_type IN ('classroom','lab','computer','hall','other'))");

        DB::statement(<<<'SQL'
            CREATE OR REPLACE FUNCTION academic_rooms_lifecycle_guard() RETURNS trigger AS $fn$
            DECLARE
                future_sessions integer;
            BEGIN
                IF NEW.capacity <= 0 THEN
                    RAISE EXCEPTION 'room capacity must be positive'
                        USING ERRCODE = 'check_violation';
                END IF;
                IF NEW.lifecycle_state IN ('maintenance', 'retired') AND OLD.lifecycle_state NOT IN ('maintenance', 'retired') THEN
                    SELECT count(*) INTO future_sessions
                      FROM class_sessions s
                     WHERE s.room_id = NEW.id
                       AND s.scheduled_on >= CURRENT_DATE;
                    IF future_sessions > 0 THEN
                        RAISE EXCEPTION 'room cannot be % while % future session(s) reference it', NEW.lifecycle_state, future_sessions
                            USING ERRCODE = 'check_violation';
                    END IF;
                END IF;
                RETURN NEW;
            END;
            $fn$ LANGUAGE plpgsql;
            SQL);
        DB::statement('DROP TRIGGER IF EXISTS academic_rooms_lifecycle_guard_trigger ON academic_rooms');
        DB::statement('CREATE TRIGGER academic_rooms_lifecycle_guard_trigger BEFORE UPDATE ON academic_rooms FOR EACH ROW EXECUTE FUNCTION academic_rooms_lifecycle_guard()');

        Schema::create('class_sections', function (Blueprint $table): void {
            $table->char('id', 36)->primary();
            $table->char('class_id', 36);
            $table->string('name');
            $table->integer('capacity');
            $table->string('lifecycle_state');
            $table->timestamps();
            $table->foreign('class_id')->references('id')->on('classes');
        });
        DB::statement('CREATE UNIQUE INDEX class_sections_class_name_unique ON class_sections (class_id, name)');
        DB::statement('ALTER TABLE class_sections ADD CONSTRAINT class_sections_capacity_check CHECK (capacity > 0)');
        DB::statement("ALTER TABLE class_sections ADD CONSTRAINT class_sections_lifecycle_check CHECK (lifecycle_state IN ('planned','open','closed','cancelled','archived'))");

        DB::statement(<<<'SQL'
            CREATE OR REPLACE FUNCTION class_sections_lifecycle_guard() RETURNS trigger AS $fn$
            DECLARE
                class_state text;
                future_sessions integer;
            BEGIN
                IF NEW.capacity <= 0 THEN
                    RAISE EXCEPTION 'section capacity must be positive'
                        USING ERRCODE = 'check_violation';
                END IF;
                IF NEW.lifecycle_state = 'open' AND OLD.lifecycle_state <> 'open' THEN
                    SELECT lifecycle_state INTO class_state
                      FROM classes WHERE id = NEW.class_id;
                    IF class_state IS DISTINCT FROM 'active' THEN
                        RAISE EXCEPTION 'a section opens only on an active class (class state: %)', class_state
                            USING ERRCODE = 'check_violation';
                    END IF;
                END IF;
                IF NEW.lifecycle_state IN ('closed', 'cancelled', 'archived') AND OLD.lifecycle_state NOT IN ('closed', 'cancelled', 'archived') THEN
                    SELECT count(*) INTO future_sessions
                      FROM class_sessions s
                     WHERE s.section_id = NEW.id
                       AND s.scheduled_on >= CURRENT_DATE;
                    IF future_sessions > 0 THEN
                        RAISE EXCEPTION 'section cannot be % while % future session(s) reference it', NEW.lifecycle_state, future_sessions
                            USING ERRCODE = 'check_violation';
                    END IF;
                END IF;
                RETURN NEW;
            END;
            $fn$ LANGUAGE plpgsql;
            SQL);
        DB::statement('DROP TRIGGER IF EXISTS class_sections_lifecycle_guard_trigger ON class_sections');
        DB::statement('CREATE TRIGGER class_sections_lifecycle_guard_trigger BEFORE UPDATE ON class_sections FOR EACH ROW EXECUTE FUNCTION class_sections_lifecycle_guard()');

        Schema::table('class_sessions', function (Blueprint $table): void {
            $table->char('room_id', 36)->nullable()->after('skill_id');
            $table->char('section_id', 36)->nullable()->after('room_id');
            $table->foreign('room_id')->references('id')->on('academic_rooms');
            $table->foreign('section_id')->references('id')->on('class_sections');
        });

        DB::statement(<<<'SQL'
            CREATE OR REPLACE FUNCTION class_sessions_timetable_guard() RETURNS trigger AS $fn$
            DECLARE
                room_state text;
                section_state text;
                section_class char(36);
                overlap integer;
            BEGIN
                IF NEW.room_id IS NOT NULL THEN
                    SELECT lifecycle_state INTO room_state FROM academic_rooms WHERE id = NEW.room_id;
                    IF room_state IS NULL THEN
                        RAISE EXCEPTION 'session references an unknown room'
                            USING ERRCODE = 'foreign_key_violation';
                    END IF;
                    IF room_state IS DISTINCT FROM 'available' THEN
                        RAISE EXCEPTION 'a session may be scheduled only in an available room (room state: %)', room_state
                            USING ERRCODE = 'check_violation';
                    END IF;
                    SELECT count(*) INTO overlap
                      FROM class_sessions s
                     WHERE s.room_id = NEW.room_id
                       AND s.scheduled_on = NEW.scheduled_on
                       AND s.id <> NEW.id
                       AND s.starts_at < NEW.ends_at
                       AND s.ends_at > NEW.starts_at;
                    IF overlap > 0 THEN
                        RAISE EXCEPTION 'room % is already booked at % on %', NEW.room_id, NEW.starts_at, NEW.scheduled_on
                            USING ERRCODE = 'check_violation';
                    END IF;
                END IF;

                IF NEW.section_id IS NOT NULL THEN
                    SELECT lifecycle_state, class_id INTO section_state, section_class
                      FROM class_sections WHERE id = NEW.section_id;
                    IF section_state IS NULL THEN
                        RAISE EXCEPTION 'session references an unknown class section'
                            USING ERRCODE = 'foreign_key_violation';
                    END IF;
                    IF section_state IS DISTINCT FROM 'open' THEN
                        RAISE EXCEPTION 'a session may be scheduled only in an open section (section state: %)', section_state
                            USING ERRCODE = 'check_violation';
                    END IF;
                    IF section_class IS DISTINCT FROM NEW.class_id THEN
                        RAISE EXCEPTION 'the session section must belong to the session class'
                            USING ERRCODE = 'check_violation';
                    END IF;
                    SELECT count(*) INTO overlap
                      FROM class_sessions s
                     WHERE s.class_id = NEW.class_id
                       AND s.section_id = NEW.section_id
                       AND s.scheduled_on = NEW.scheduled_on
                       AND s.id <> NEW.id
                       AND s.starts_at < NEW.ends_at
                       AND s.ends_at > NEW.starts_at;
                    IF overlap > 0 THEN
                        RAISE EXCEPTION 'section % is already booked at % on %', NEW.section_id, NEW.starts_at, NEW.scheduled_on
                            USING ERRCODE = 'check_violation';
                    END IF;
                ELSE
                    SELECT count(*) INTO overlap
                      FROM class_sessions s
                     WHERE s.class_id = NEW.class_id
                       AND s.section_id IS NULL
                       AND s.scheduled_on = NEW.scheduled_on
                       AND s.id <> NEW.id
                       AND s.starts_at < NEW.ends_at
                       AND s.ends_at > NEW.starts_at;
                    IF overlap > 0 THEN
                        RAISE EXCEPTION 'class % already has a whole-class session at % on %', NEW.class_id, NEW.starts_at, NEW.scheduled_on
                            USING ERRCODE = 'check_violation';
                    END IF;
                END IF;

                RETURN NEW;
            END;
            $fn$ LANGUAGE plpgsql;
            SQL);
        DB::statement('DROP TRIGGER IF EXISTS class_sessions_timetable_guard_trigger ON class_sessions');
        DB::statement('CREATE TRIGGER class_sessions_timetable_guard_trigger BEFORE INSERT OR UPDATE ON class_sessions FOR EACH ROW EXECUTE FUNCTION class_sessions_timetable_guard()');

        DB::statement(<<<'SQL'
            CREATE OR REPLACE FUNCTION class_sessions_timetable_identity_guard() RETURNS trigger AS $fn$
            BEGIN
                IF OLD.room_id IS DISTINCT FROM NEW.room_id
                   OR OLD.section_id IS DISTINCT FROM NEW.section_id
                   OR OLD.scheduled_on IS DISTINCT FROM NEW.scheduled_on
                   OR OLD.starts_at IS DISTINCT FROM NEW.starts_at
                   OR OLD.ends_at IS DISTINCT FROM NEW.ends_at THEN
                    RAISE EXCEPTION 'a scheduled session timetable is immutable; rebook through a new session'
                        USING ERRCODE = 'check_violation';
                END IF;
                RETURN NEW;
            END;
            $fn$ LANGUAGE plpgsql;
            SQL);
        DB::statement('DROP TRIGGER IF EXISTS class_sessions_timetable_identity_guard_trigger ON class_sessions');
        DB::statement('CREATE TRIGGER class_sessions_timetable_identity_guard_trigger BEFORE UPDATE ON class_sessions FOR EACH ROW EXECUTE FUNCTION class_sessions_timetable_identity_guard()');
    }

    public function down(): void
    {
        DB::statement('DROP TRIGGER IF EXISTS class_sessions_timetable_identity_guard_trigger ON class_sessions');
        DB::statement('DROP FUNCTION IF EXISTS class_sessions_timetable_identity_guard()');
        DB::statement('DROP TRIGGER IF EXISTS class_sessions_timetable_guard_trigger ON class_sessions');
        DB::statement('DROP FUNCTION IF EXISTS class_sessions_timetable_guard()');

        Schema::table('class_sessions', function (Blueprint $table): void {
            $table->dropForeign(['section_id']);
            $table->dropForeign(['room_id']);
            $table->dropColumn(['section_id', 'room_id']);
        });

        DB::statement('DROP TRIGGER IF EXISTS class_sections_lifecycle_guard_trigger ON class_sections');
        DB::statement('DROP FUNCTION IF EXISTS class_sections_lifecycle_guard()');
        Schema::dropIfExists('class_sections');

        DB::statement('DROP TRIGGER IF EXISTS academic_rooms_lifecycle_guard_trigger ON academic_rooms');
        DB::statement('DROP FUNCTION IF EXISTS academic_rooms_lifecycle_guard()');
        Schema::dropIfExists('academic_rooms');
    }
};
