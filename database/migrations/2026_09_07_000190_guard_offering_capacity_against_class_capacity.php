<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Support\Facades\DB;

/**
 * Close the offering/class capacity invariant at the database boundary.
 *
 * A new class is born with `class.capacity <= offering.capacity`
 * (academic_class_authority_guard, 000160) and its offering/branch/level/
 * period identity plus established offering provenance are immutable. But
 * nothing prevented an offering from being resized DOWN below the capacity
 * of a class that already references it — silently violating the invariant
 * that every referencing class's declared capacity stays within the
 * offering's declared capacity.
 *
 * The application command (ManageAcademicOffering::resizeCapacity) is
 * authoritative, but the boundary must reject a direct SQL statement the
 * same way — without relying on the application layer being hit.
 *
 * The live-seat (requested/active/frozen) floor when resizing is already
 * enforced by academic_offering_capacity_guard (000160) on the same
 * BEFORE UPDATE OF capacity event; this guard deliberately adds only the
 * class-capacity bound and does not re-implement that check, so the two
 * invariants stay independently owned instead of shadowing each other.
 *
 * Deployment roles must still deny arbitrary table DML to preserve the
 * broader boundary; this guard simply removes the resize hole at the SQL
 * layer.
 */
return new class extends Migration
{
    public function up(): void
    {
        DB::statement(<<<'SQL'
            CREATE OR REPLACE FUNCTION academic_offering_capacity_class_bound_guard() RETURNS trigger AS $fn$
            DECLARE
                max_class_capacity integer;
            BEGIN
                IF NEW.capacity IS NOT DISTINCT FROM OLD.capacity THEN
                    RETURN NEW;
                END IF;
                IF NEW.capacity < 1 THEN
                    RAISE EXCEPTION 'an offering requires a positive capacity'
                        USING ERRCODE = 'check_violation';
                END IF;

                -- The declared capacity must never fall below the largest
                -- declared capacity of a class currently referencing it.
                SELECT COALESCE(max(c.capacity), 0) INTO max_class_capacity
                  FROM classes c
                 WHERE c.offering_id = NEW.id;
                IF NEW.capacity < max_class_capacity THEN
                    RAISE EXCEPTION 'offering capacity cannot fall below the capacity (%) of a referencing class', max_class_capacity
                        USING ERRCODE = 'check_violation';
                END IF;

                RETURN NEW;
            END;
            $fn$ LANGUAGE plpgsql;
            SQL);
        DB::statement('DROP TRIGGER IF EXISTS academic_offering_capacity_class_bound_guard_trigger ON offerings');
        DB::statement('CREATE TRIGGER academic_offering_capacity_class_bound_guard_trigger BEFORE UPDATE OF capacity ON offerings FOR EACH ROW EXECUTE FUNCTION academic_offering_capacity_class_bound_guard()');
    }

    public function down(): void
    {
        DB::statement('DROP TRIGGER IF EXISTS academic_offering_capacity_class_bound_guard_trigger ON offerings');
        DB::statement('DROP FUNCTION IF EXISTS academic_offering_capacity_class_bound_guard()');
    }
};
