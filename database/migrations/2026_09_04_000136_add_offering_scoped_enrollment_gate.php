<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Support\Facades\DB;

/**
 * AC5: level-aware enrollment-to-offering end-to-end (WP-2 F3 consumer).
 *
 * An Offering is the packaging unit Finance consumes (WP2-DEC-03). When a
 * class targets a ProgramVersionLevel, a new enrollment must target the
 * open Offering that packages exactly that branch x level x term, so a
 * charge can be attributed and the financial gate scoped. Legacy classes
 * with no level keep the NULL-offering path.
 *
 * The command already enforces this; this guard makes it a DB invariant so a
 * direct SQL seat cannot bypass the offering packaging rule. It also rejects a
 * level class bound to an offering whose level/term do not match the class and
 * rejects cancelled offerings.
 */
return new class extends Migration
{
    public function up(): void
    {
        DB::statement(<<<'SQL'
            CREATE OR REPLACE FUNCTION enrollment_offering_required_for_level_class() RETURNS trigger AS $fn$
            DECLARE
                class_level char(36);
                class_period char(36);
                offering_level char(36);
                offering_period char(36);
                offering_state text;
            BEGIN
                IF TG_OP = 'UPDATE' AND NEW.class_id IS NOT DISTINCT FROM OLD.class_id
                   AND NEW.offering_id IS NOT DISTINCT FROM OLD.offering_id THEN
                    RETURN NEW;
                END IF;

                SELECT program_version_level_id, period_id INTO class_level, class_period
                  FROM classes WHERE id = NEW.class_id;
                IF class_level IS NULL THEN
                    RETURN NEW; -- legacy non-level class keeps the NULL offering path
                END IF;
                IF NEW.offering_id IS NULL THEN
                    RAISE EXCEPTION 'a level-targeted enrollment requires an academic offering'
                        USING ERRCODE = 'check_violation';
                END IF;

                SELECT program_version_level_id, academic_period_id, lifecycle_state
                  INTO offering_level, offering_period, offering_state
                  FROM offerings WHERE id = NEW.offering_id;
                IF offering_level IS NULL THEN
                    RETURN NEW; -- the enrollment->offering FK reports a missing offering
                END IF;
                IF offering_level <> class_level OR offering_period <> class_period THEN
                    RAISE EXCEPTION 'the enrollment offering must match the class level and period'
                        USING ERRCODE = 'check_violation';
                END IF;
                IF offering_state = 'cancelled' THEN
                    RAISE EXCEPTION 'a cancelled offering cannot accept an enrollment'
                        USING ERRCODE = 'check_violation';
                END IF;
                RETURN NEW;
            END;
            $fn$ LANGUAGE plpgsql
            SQL);
        DB::statement('CREATE TRIGGER enrollments_offering_required_for_level_class_trigger BEFORE INSERT OR UPDATE OF class_id, offering_id ON enrollments FOR EACH ROW EXECUTE FUNCTION enrollment_offering_required_for_level_class()');
    }

    public function down(): void
    {
        DB::statement('DROP TRIGGER IF EXISTS enrollments_offering_required_for_level_class_trigger ON enrollments');
        DB::statement('DROP FUNCTION IF EXISTS enrollment_offering_required_for_level_class()');
    }
};
