<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Schema;

/**
 * Student lifecycle completion (Student domain).
 *
 * - student_branch_transfers: append-only home-branch transfer history; the
 *   student's immutable originating_branch_id is never rewritten, and the
 *   current_home_branch_id is the latest state.
 * - student_hold_events: append-only freeze/resume facts for student-level
 *   holds (freeze is blocked only by an open freeze; resume requires one).
 * - student_communication_preferences: per-channel enabled preference owned
 *   by Student so the Communication module can consume it when sending.
 */
return new class extends Migration
{
    public function up(): void
    {
        Schema::create('student_branch_transfers', function (Blueprint $table): void {
            $table->bigIncrements('seq');
            $table->char('id', 36)->primary();
            $table->char('student_id', 36);
            $table->char('from_branch_id', 36)->nullable();
            $table->char('to_branch_id', 36);
            $table->date('effective_from');
            $table->string('reason');
            $table->char('transferred_by', 36);
            $table->timestamps();
            $table->foreign('student_id')->references('id')->on('students');
            $table->foreign('from_branch_id')->references('id')->on('branches');
            $table->foreign('to_branch_id')->references('id')->on('branches');
        });
        DB::statement('ALTER TABLE student_branch_transfers ADD CONSTRAINT student_branch_transfers_distinct_check CHECK (from_branch_id IS NULL OR from_branch_id <> to_branch_id)');
        DB::statement(<<<'SQL'
            CREATE OR REPLACE FUNCTION student_branch_transfers_consistency() RETURNS trigger AS $fn$
            DECLARE
                student_state text;
                current_home char(36);
            BEGIN
                SELECT s.current_home_branch_id INTO current_home FROM students s WHERE s.id = NEW.student_id;
                IF current_home IS DISTINCT FROM NEW.from_branch_id THEN
                    RAISE EXCEPTION 'branch transfer from_branch_id must equal the student current home branch at append time'
                        USING ERRCODE = 'check_violation';
                END IF;

                SELECT ss.status INTO student_state
                  FROM student_statuses ss
                 WHERE ss.student_id = NEW.student_id
                 ORDER BY ss.seq DESC
                 LIMIT 1;
                IF student_state IS NULL OR student_state <> 'active' THEN
                    RAISE EXCEPTION 'a branch transfer requires the student to be active'
                        USING ERRCODE = 'check_violation';
                END IF;
                RETURN NEW;
            END;
            $fn$ LANGUAGE plpgsql;
            SQL);
        DB::statement('CREATE TRIGGER student_branch_transfers_consistency_trigger BEFORE INSERT ON student_branch_transfers FOR EACH ROW EXECUTE FUNCTION student_branch_transfers_consistency()');
        DB::statement(<<<'SQL'
            CREATE OR REPLACE FUNCTION student_branch_transfers_append_only() RETURNS trigger AS $fn$
            BEGIN
                RAISE EXCEPTION 'student branch transfer history is append-only';
            END;
            $fn$ LANGUAGE plpgsql;
            SQL);
        DB::statement('CREATE TRIGGER student_branch_transfers_append_only_trigger BEFORE UPDATE OR DELETE ON student_branch_transfers FOR EACH ROW EXECUTE FUNCTION student_branch_transfers_append_only()');

        Schema::create('student_hold_events', function (Blueprint $table): void {
            $table->bigIncrements('seq');
            $table->char('id', 36)->primary();
            $table->char('student_id', 36);
            $table->string('action');
            $table->date('effective_from');
            $table->string('reason');
            $table->char('actor_id', 36);
            $table->timestamps();
            $table->foreign('student_id')->references('id')->on('students');
        });
        DB::statement("ALTER TABLE student_hold_events ADD CONSTRAINT student_hold_events_action_check CHECK (action IN ('freeze', 'resume'))");
        DB::statement(<<<'SQL'
            CREATE OR REPLACE FUNCTION student_hold_events_append_only() RETURNS trigger AS $fn$
            BEGIN
                RAISE EXCEPTION 'student hold history is append-only';
            END;
            $fn$ LANGUAGE plpgsql;
            SQL);
        DB::statement('CREATE TRIGGER student_hold_events_append_only_trigger BEFORE UPDATE OR DELETE ON student_hold_events FOR EACH ROW EXECUTE FUNCTION student_hold_events_append_only()');
        DB::statement(<<<'SQL'
            CREATE OR REPLACE FUNCTION student_hold_events_consistency() RETURNS trigger AS $fn$
            DECLARE
                student_state text;
                latest_action text;
            BEGIN
                SELECT ss.status INTO student_state
                  FROM student_statuses ss
                 WHERE ss.student_id = NEW.student_id
                 ORDER BY ss.seq DESC
                 LIMIT 1;
                IF student_state IS NULL OR student_state <> 'active' THEN
                    RAISE EXCEPTION 'a student hold transition requires the student to be active'
                        USING ERRCODE = 'check_violation';
                END IF;

                SELECT she.action INTO latest_action
                  FROM student_hold_events she
                 WHERE she.student_id = NEW.student_id
                 ORDER BY she.seq DESC
                 LIMIT 1;
                IF NEW.action = 'freeze' AND latest_action = 'freeze' THEN
                    RAISE EXCEPTION 'the student already has an open freeze'
                        USING ERRCODE = 'check_violation';
                END IF;
                IF NEW.action = 'resume' AND latest_action IS DISTINCT FROM 'freeze' THEN
                    RAISE EXCEPTION 'only a frozen student can be resumed'
                        USING ERRCODE = 'check_violation';
                END IF;
                RETURN NEW;
            END;
            $fn$ LANGUAGE plpgsql;
            SQL);
        DB::statement('CREATE TRIGGER student_hold_events_consistency_trigger BEFORE INSERT ON student_hold_events FOR EACH ROW EXECUTE FUNCTION student_hold_events_consistency()');

        Schema::create('student_communication_preferences', function (Blueprint $table): void {
            $table->char('id', 36)->primary();
            $table->char('student_id', 36);
            $table->string('channel');
            $table->boolean('enabled');
            $table->char('updated_by', 36);
            $table->timestamps();
            $table->foreign('student_id')->references('id')->on('students');
            $table->unique(['student_id', 'channel']);
        });
        DB::statement("ALTER TABLE student_communication_preferences ADD CONSTRAINT student_communication_preferences_channel_check CHECK (channel IN ('email', 'sms', 'whatsapp', 'push'))");
    }

    public function down(): void
    {
        Schema::dropIfExists('student_communication_preferences');
        Schema::dropIfExists('student_hold_events');
        DB::statement('DROP TRIGGER IF EXISTS student_branch_transfers_append_only_trigger ON student_branch_transfers');
        DB::statement('DROP FUNCTION IF EXISTS student_branch_transfers_append_only()');
        Schema::dropIfExists('student_branch_transfers');
    }
};
