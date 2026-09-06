<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Schema;

/**
 * Resource roots were created before the fourth-architecture scope contract.
 * Existing rows remain nullable/unknown and are fail-closed by reads, but no
 * new asset, book-copy, or work-order fact may be created without an active
 * branch and its matching organization.
 */
return new class extends Migration
{
    /** @var list<string> */
    private array $tables = ['assets', 'book_copies', 'work_orders'];

    public function up(): void
    {
        foreach ($this->tables as $tableName) {
            Schema::table($tableName, function (Blueprint $table): void {
                $table->char('organization_id', 36)->nullable();
                $table->char('originating_branch_id', 36)->nullable();
                $table->foreign('organization_id')->references('id')->on('organizations');
                $table->foreign('originating_branch_id')->references('id')->on('branches');
                $table->index(['organization_id', 'originating_branch_id']);
            });

            DB::statement("ALTER TABLE {$tableName} ADD CONSTRAINT {$tableName}_scope_pair_check CHECK ((organization_id IS NULL AND originating_branch_id IS NULL) OR (organization_id IS NOT NULL AND originating_branch_id IS NOT NULL))");
        }

        DB::statement(<<<'SQL'
            CREATE OR REPLACE FUNCTION resource_root_provenance_guard() RETURNS trigger AS $fn$
            BEGIN
                IF TG_OP = 'UPDATE'
                   AND (NEW.organization_id IS DISTINCT FROM OLD.organization_id
                        OR NEW.originating_branch_id IS DISTINCT FROM OLD.originating_branch_id) THEN
                    RAISE EXCEPTION 'resource root provenance is immutable'
                        USING ERRCODE = 'check_violation';
                END IF;
                IF NEW.organization_id IS NULL OR NEW.originating_branch_id IS NULL THEN
                    RAISE EXCEPTION 'resource roots require organization and originating branch provenance'
                        USING ERRCODE = 'check_violation';
                END IF;
                IF NOT EXISTS (
                    SELECT 1
                      FROM branches b
                      JOIN campus_assignments ca ON ca.branch_id = b.id AND ca.effective_from <= CURRENT_DATE AND (ca.effective_to IS NULL OR ca.effective_to > CURRENT_DATE)
                      JOIN campuses c ON c.id = ca.campus_id
                      JOIN organizations o ON o.id = c.organization_id
                     WHERE b.id = NEW.originating_branch_id
                       AND b.lifecycle_state = 'active'
                       AND c.lifecycle_state = 'active'
                       AND o.lifecycle_state = 'active'
                       AND c.organization_id = NEW.organization_id
                ) THEN
                    RAISE EXCEPTION 'resource root provenance must match an active branch and organization topology'
                        USING ERRCODE = 'check_violation';
                END IF;
                RETURN NEW;
            END;
            $fn$ LANGUAGE plpgsql;
            SQL);

        foreach ($this->tables as $tableName) {
            DB::statement("CREATE TRIGGER {$tableName}_resource_provenance_trigger BEFORE INSERT OR UPDATE ON {$tableName} FOR EACH ROW EXECUTE FUNCTION resource_root_provenance_guard()");
        }
    }

    public function down(): void
    {
        foreach ($this->tables as $tableName) {
            DB::statement("DROP TRIGGER IF EXISTS {$tableName}_resource_provenance_trigger ON {$tableName}");
            DB::statement("ALTER TABLE {$tableName} DROP CONSTRAINT IF EXISTS {$tableName}_scope_pair_check");
            Schema::table($tableName, function (Blueprint $table): void {
                $table->dropForeign(['organization_id']);
                $table->dropForeign(['originating_branch_id']);
                $table->dropIndex(['organization_id', 'originating_branch_id']);
                $table->dropColumn(['organization_id', 'originating_branch_id']);
            });
        }
        DB::statement('DROP FUNCTION IF EXISTS resource_root_provenance_guard()');
    }
};
