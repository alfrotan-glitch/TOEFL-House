<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Support\Facades\DB;

/**
 * Correct the class-waitlist update guard to the ratified lifecycle.
 *
 * Migration 000131 forbade offered -> expired at the trigger level while
 * both the WP-AO architecture decision ("offered → enrolled/expired") and
 * the certified WaitlistLifecycle domain allow it, so declining an offer
 * by expiry failed with a raw check violation. This replaces the guard
 * function so offered entries may move to enrolled (accept) or expired
 * (decline); every other edge stays exactly as 000131 defined it.
 */
return new class extends Migration
{
    public function up(): void
    {
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
                IF OLD.lifecycle_state = 'offered' AND NEW.lifecycle_state NOT IN ('enrolled', 'expired') THEN
                    RAISE EXCEPTION 'an offered waitlist entry can move only to enrolled or expired'
                        USING ERRCODE = 'check_violation';
                END IF;
                RETURN NEW;
            END;
            $fn$ LANGUAGE plpgsql;
            SQL);
    }

    public function down(): void
    {
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
    }
};
