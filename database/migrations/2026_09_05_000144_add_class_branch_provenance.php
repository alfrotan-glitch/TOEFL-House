<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Schema;

/**
 * Give every newly-created delivery class an immutable operational branch.
 * Existing rows may remain un-attributed until a governed data-remediation
 * decision; they are not treated as visible to any branch-scoped reader.
 */
return new class extends Migration
{
    public function up(): void
    {
        Schema::table('classes', function (Blueprint $table): void {
            $table->char('branch_id', 36)->nullable();
            $table->foreign('branch_id')->references('id')->on('branches');
        });
        DB::statement('CREATE INDEX classes_branch_lifecycle_index ON classes (branch_id, lifecycle_state)');
        DB::statement(<<<'SQL'
            CREATE OR REPLACE FUNCTION classes_branch_provenance_guard() RETURNS trigger AS $fn$
            BEGIN
                IF TG_OP = 'INSERT' AND NEW.branch_id IS NULL THEN
                    RAISE EXCEPTION 'new classes require branch provenance'
                        USING ERRCODE = 'check_violation';
                END IF;
                IF TG_OP = 'UPDATE' AND NEW.branch_id IS DISTINCT FROM OLD.branch_id THEN
                    RAISE EXCEPTION 'class branch provenance is immutable'
                        USING ERRCODE = 'check_violation';
                END IF;
                RETURN NEW;
            END;
            $fn$ LANGUAGE plpgsql;
            SQL);
        DB::statement('CREATE TRIGGER classes_branch_provenance_guard BEFORE INSERT OR UPDATE OF branch_id ON classes FOR EACH ROW EXECUTE FUNCTION classes_branch_provenance_guard()');
        DB::statement(<<<'SQL'
            CREATE OR REPLACE FUNCTION class_membership_branch_guard() RETURNS trigger AS $fn$
            BEGIN
                IF NOT EXISTS (
                    SELECT 1 FROM classes c
                     WHERE c.id = NEW.class_id
                       AND c.branch_id IS NOT NULL
                ) THEN
                    RAISE EXCEPTION 'enrollment or waitlist membership requires class branch provenance'
                        USING ERRCODE = 'check_violation';
                END IF;
                RETURN NEW;
            END;
            $fn$ LANGUAGE plpgsql;
            SQL);
        DB::statement('CREATE TRIGGER enrollments_class_branch_guard BEFORE INSERT OR UPDATE OF class_id ON enrollments FOR EACH ROW EXECUTE FUNCTION class_membership_branch_guard()');
        DB::statement('CREATE TRIGGER waitlist_class_branch_guard BEFORE INSERT OR UPDATE OF class_id ON class_waitlist_entries FOR EACH ROW EXECUTE FUNCTION class_membership_branch_guard()');
    }

    public function down(): void
    {
        DB::statement('DROP TRIGGER IF EXISTS waitlist_class_branch_guard ON class_waitlist_entries');
        DB::statement('DROP TRIGGER IF EXISTS enrollments_class_branch_guard ON enrollments');
        DB::statement('DROP FUNCTION IF EXISTS class_membership_branch_guard()');
        DB::statement('DROP TRIGGER IF EXISTS classes_branch_provenance_guard ON classes');
        DB::statement('DROP FUNCTION IF EXISTS classes_branch_provenance_guard()');
        DB::statement('DROP INDEX IF EXISTS classes_branch_lifecycle_index');
        Schema::table('classes', function (Blueprint $table): void {
            $table->dropForeign(['branch_id']);
            $table->dropColumn('branch_id');
        });
    }
};
