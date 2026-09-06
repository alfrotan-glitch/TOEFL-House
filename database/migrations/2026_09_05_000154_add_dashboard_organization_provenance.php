<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Schema;

/** Dashboards and their pins are organization-scoped reporting configuration. */
return new class extends Migration
{
    public function up(): void
    {
        Schema::table('dashboards', function (Blueprint $table): void {
            $table->char('organization_id', 36)->nullable();
            $table->foreign('organization_id')->references('id')->on('organizations');
            $table->index(['organization_id', 'name']);
        });
        DB::statement(<<<'SQL'
            DO $migration$
            BEGIN
                IF EXISTS (SELECT 1 FROM dashboards WHERE organization_id IS NULL)
                   OR EXISTS (
                       SELECT 1 FROM dashboards d
                        WHERE NOT EXISTS (
                            SELECT 1 FROM organizations o
                             WHERE o.id = d.organization_id
                               AND o.lifecycle_state = 'active'
                        )
                   )
                   OR EXISTS (
                       SELECT 1 FROM dashboard_pins dp
                       JOIN dashboards d ON d.id = dp.dashboard_id
                        WHERE dp.scope_type = 'branch'
                          AND NOT EXISTS (
                              SELECT 1
                                FROM campus_assignments ca
                                JOIN branches b ON b.id = ca.branch_id
                                JOIN campuses c ON c.id = ca.campus_id
                                JOIN organizations o ON o.id = c.organization_id
                               WHERE ca.branch_id = dp.scope_id
                                 AND b.lifecycle_state = 'active'
                                 AND ca.effective_from <= CURRENT_DATE AND (ca.effective_to IS NULL OR ca.effective_to > CURRENT_DATE)
                                 AND c.organization_id = d.organization_id
                                 AND c.lifecycle_state = 'active'
                                 AND o.lifecycle_state = 'active'
                          )
                   )
                   OR EXISTS (
                       SELECT 1 FROM dashboard_pins dp
                       JOIN dashboards d ON d.id = dp.dashboard_id
                        WHERE dp.scope_type = 'student'
                          AND NOT EXISTS (
                              SELECT 1
                                FROM students s
                                JOIN branches b ON b.id = COALESCE(NULLIF(btrim(s.current_home_branch_id), ''), NULLIF(btrim(s.originating_branch_id), ''))
                                JOIN campus_assignments ca ON ca.branch_id = b.id AND ca.effective_from <= CURRENT_DATE AND (ca.effective_to IS NULL OR ca.effective_to > CURRENT_DATE)
                                JOIN campuses c ON c.id = ca.campus_id
                                JOIN organizations o ON o.id = c.organization_id
                               WHERE s.id = dp.scope_id
                                 AND b.lifecycle_state = 'active'
                                 AND c.organization_id = d.organization_id
                                 AND c.lifecycle_state = 'active'
                                 AND o.lifecycle_state = 'active'
                          )
                   )
                   OR EXISTS (
                       SELECT 1 FROM dashboard_pins dp
                       JOIN dashboards d ON d.id = dp.dashboard_id
                        WHERE dp.scope_type = 'class'
                          AND NOT EXISTS (
                              SELECT 1
                                FROM classes cls
                                JOIN branches b ON b.id = cls.branch_id
                                JOIN campus_assignments ca ON ca.branch_id = b.id AND ca.effective_from <= CURRENT_DATE AND (ca.effective_to IS NULL OR ca.effective_to > CURRENT_DATE)
                                JOIN campuses c ON c.id = ca.campus_id
                                JOIN organizations o ON o.id = c.organization_id
                               WHERE cls.id = dp.scope_id
                                 AND b.lifecycle_state = 'active'
                                 AND c.organization_id = d.organization_id
                                 AND c.lifecycle_state = 'active'
                                 AND o.lifecycle_state = 'active'
                          )
                   ) THEN
                    RAISE EXCEPTION 'dashboard migration requires active dashboard organization and matching branch, student, or class provenance'
                        USING ERRCODE = 'check_violation';
                END IF;
            END
            $migration$
            SQL);
        DB::statement('ALTER TABLE dashboards ALTER COLUMN organization_id SET NOT NULL');
        DB::statement("ALTER TABLE dashboards ADD CONSTRAINT dashboards_organization_check CHECK (btrim(organization_id) <> '')");
        DB::statement('DROP INDEX IF EXISTS dashboards_name_unique');
        DB::statement('CREATE UNIQUE INDEX dashboards_organization_name_unique ON dashboards (organization_id, name)');
        DB::statement('ALTER TABLE dashboard_pins DROP CONSTRAINT IF EXISTS dashboard_pins_scope_type_check');
        DB::statement("ALTER TABLE dashboard_pins ADD CONSTRAINT dashboard_pins_scope_type_check CHECK (scope_type IN ('global','student','class','fund','branch'))");
        DB::statement(<<<'SQL'
            CREATE OR REPLACE FUNCTION dashboards_provenance_guard() RETURNS trigger AS $fn$
            BEGIN
                IF NOT EXISTS (
                    SELECT 1 FROM organizations
                     WHERE id = NEW.organization_id
                       AND lifecycle_state = 'active'
                ) THEN
                    RAISE EXCEPTION 'dashboard organization provenance must name an active organization'
                        USING ERRCODE = 'check_violation';
                END IF;
                RETURN NEW;
            END;
            $fn$ LANGUAGE plpgsql;
            SQL);
        DB::statement('CREATE TRIGGER dashboards_provenance_trigger BEFORE INSERT OR UPDATE OF organization_id ON dashboards FOR EACH ROW EXECUTE FUNCTION dashboards_provenance_guard()');
        DB::statement(<<<'SQL'
            CREATE OR REPLACE FUNCTION dashboard_pins_provenance_guard() RETURNS trigger AS $fn$
            DECLARE
                dashboard_organization char(36);
            BEGIN
                SELECT organization_id INTO dashboard_organization
                  FROM dashboards WHERE id = NEW.dashboard_id;
                IF NOT FOUND THEN
                    RAISE EXCEPTION 'dashboard pin requires an existing dashboard'
                        USING ERRCODE = 'foreign_key_violation';
                END IF;
                IF NEW.scope_type = 'branch'
                   AND NOT EXISTS (
                       SELECT 1
                         FROM campus_assignments ca
                         JOIN branches b ON b.id = ca.branch_id
                         JOIN campuses c ON c.id = ca.campus_id
                         JOIN organizations o ON o.id = c.organization_id
                        WHERE ca.branch_id = NEW.scope_id
                          AND b.lifecycle_state = 'active'
                          AND ca.effective_from <= CURRENT_DATE AND (ca.effective_to IS NULL OR ca.effective_to > CURRENT_DATE)
                          AND c.organization_id = dashboard_organization
                          AND c.lifecycle_state = 'active'
                          AND o.lifecycle_state = 'active'
                   ) THEN
                    RAISE EXCEPTION 'branch dashboard pins require branch provenance inside the dashboard organization'
                        USING ERRCODE = 'check_violation';
                END IF;
                IF NEW.scope_type = 'student'
                   AND NOT EXISTS (
                       SELECT 1
                         FROM students s
                         JOIN branches b ON b.id = COALESCE(NULLIF(btrim(s.current_home_branch_id), ''), NULLIF(btrim(s.originating_branch_id), ''))
                         JOIN campus_assignments ca ON ca.branch_id = b.id AND ca.effective_from <= CURRENT_DATE AND (ca.effective_to IS NULL OR ca.effective_to > CURRENT_DATE)
                         JOIN campuses c ON c.id = ca.campus_id
                         JOIN organizations o ON o.id = c.organization_id
                        WHERE s.id = NEW.scope_id
                          AND b.lifecycle_state = 'active'
                          AND c.organization_id = dashboard_organization
                          AND c.lifecycle_state = 'active'
                          AND o.lifecycle_state = 'active'
                   ) THEN
                    RAISE EXCEPTION 'student dashboard pins require student provenance inside the dashboard organization'
                        USING ERRCODE = 'check_violation';
                END IF;
                IF NEW.scope_type = 'class'
                   AND NOT EXISTS (
                       SELECT 1
                         FROM classes cls
                         JOIN branches b ON b.id = cls.branch_id
                         JOIN campus_assignments ca ON ca.branch_id = b.id AND ca.effective_from <= CURRENT_DATE AND (ca.effective_to IS NULL OR ca.effective_to > CURRENT_DATE)
                         JOIN campuses c ON c.id = ca.campus_id
                         JOIN organizations o ON o.id = c.organization_id
                        WHERE cls.id = NEW.scope_id
                          AND b.lifecycle_state = 'active'
                          AND c.organization_id = dashboard_organization
                          AND c.lifecycle_state = 'active'
                          AND o.lifecycle_state = 'active'
                   ) THEN
                    RAISE EXCEPTION 'class dashboard pins require class provenance inside the dashboard organization'
                        USING ERRCODE = 'check_violation';
                END IF;
                RETURN NEW;
            END;
            $fn$ LANGUAGE plpgsql;
            SQL);
        DB::statement('CREATE TRIGGER dashboard_pins_provenance_trigger BEFORE INSERT ON dashboard_pins FOR EACH ROW EXECUTE FUNCTION dashboard_pins_provenance_guard()');
    }

    public function down(): void
    {
        // Every migrated dashboard is organization-owned. The old schema has
        // no lossless representation for that owner, so downgrade only while
        // the affected reporting configuration is empty.
        DB::statement(<<<'SQL'
            DO $rollback$
            BEGIN
                IF EXISTS (SELECT 1 FROM dashboards WHERE organization_id IS NOT NULL)
                   OR EXISTS (SELECT 1 FROM dashboard_pins WHERE scope_type = 'branch') THEN
                    RAISE EXCEPTION 'cannot roll back dashboard organization provenance while governed dashboards or branch pins exist; export or reconcile them first'
                        USING ERRCODE = 'check_violation';
                END IF;
            END
            $rollback$
            SQL);
        DB::statement('DROP TRIGGER IF EXISTS dashboard_pins_provenance_trigger ON dashboard_pins');
        DB::statement('DROP FUNCTION IF EXISTS dashboard_pins_provenance_guard()');
        DB::statement('DROP TRIGGER IF EXISTS dashboards_provenance_trigger ON dashboards');
        DB::statement('DROP FUNCTION IF EXISTS dashboards_provenance_guard()');
        DB::statement('ALTER TABLE dashboard_pins DROP CONSTRAINT IF EXISTS dashboard_pins_scope_type_check');
        DB::statement("ALTER TABLE dashboard_pins ADD CONSTRAINT dashboard_pins_scope_type_check CHECK (scope_type IN ('global','student','class','fund'))");
        DB::statement('ALTER TABLE dashboards DROP CONSTRAINT IF EXISTS dashboards_organization_check');
        DB::statement('DROP INDEX IF EXISTS dashboards_organization_name_unique');
        DB::statement('CREATE UNIQUE INDEX dashboards_name_unique ON dashboards (name)');
        DB::statement('DROP INDEX IF EXISTS dashboards_organization_id_name_index');
        Schema::table('dashboards', function (Blueprint $table): void {
            $table->dropForeign(['organization_id']);
            $table->dropColumn('organization_id');
        });
    }
};
