<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Schema;

/**
 * Branchless work is organization-scoped, never globally scoped. Persist the
 * organization alongside branch provenance so Work Management can be rebuilt
 * and authorized without treating NULL branch_id as a wildcard.
 */
return new class extends Migration
{
    public function up(): void
    {
        Schema::table('workflow_instances', function (Blueprint $table): void {
            $table->char('organization_id', 36)->nullable();
            $table->foreign('organization_id')->references('id')->on('organizations');
            $table->index(['organization_id', 'lifecycle_state']);
        });
        Schema::table('work_items', function (Blueprint $table): void {
            $table->char('organization_id', 36)->nullable();
            $table->foreign('organization_id')->references('id')->on('organizations');
            $table->index(['organization_id', 'lifecycle_state']);
        });

        // Existing branch-scoped rows can inherit organization provenance from
        // the active campus topology. Rows that cannot be proven are rejected
        // below rather than exposed as global work.
        DB::statement(<<<'SQL'
            UPDATE workflow_instances wi
               SET organization_id = c.organization_id
              FROM campus_assignments ca
              JOIN branches b ON b.id = ca.branch_id
              JOIN campuses c ON c.id = ca.campus_id
              JOIN organizations o ON o.id = c.organization_id
             WHERE wi.branch_id = ca.branch_id
               AND b.lifecycle_state = 'active'
               AND c.lifecycle_state = 'active'
               AND o.lifecycle_state = 'active'
               AND ca.effective_from <= CURRENT_DATE AND (ca.effective_to IS NULL OR ca.effective_to > CURRENT_DATE)
               AND wi.organization_id IS NULL
            SQL);
        DB::statement(<<<'SQL'
            UPDATE work_items wi
               SET organization_id = c.organization_id
              FROM campus_assignments ca
              JOIN branches b ON b.id = ca.branch_id
              JOIN campuses c ON c.id = ca.campus_id
              JOIN organizations o ON o.id = c.organization_id
             WHERE wi.branch_id = ca.branch_id
               AND b.lifecycle_state = 'active'
               AND c.lifecycle_state = 'active'
               AND o.lifecycle_state = 'active'
               AND ca.effective_from <= CURRENT_DATE AND (ca.effective_to IS NULL OR ca.effective_to > CURRENT_DATE)
               AND wi.organization_id IS NULL
            SQL);
        DB::statement(<<<'SQL'
            UPDATE work_items wi
               SET organization_id = workflow.organization_id
              FROM workflow_instances workflow
             WHERE wi.workflow_instance_id = workflow.id
               AND wi.organization_id IS NULL
            SQL);
        DB::statement(<<<'SQL'
            DO $migration$
            BEGIN
                IF EXISTS (SELECT 1 FROM workflow_instances WHERE organization_id IS NULL)
                   OR EXISTS (SELECT 1 FROM work_items WHERE organization_id IS NULL)
                   OR EXISTS (SELECT 1 FROM workflow_instances wi LEFT JOIN organizations o ON o.id = wi.organization_id WHERE o.id IS NULL OR o.lifecycle_state <> 'active')
                   OR EXISTS (SELECT 1 FROM work_items wi LEFT JOIN organizations o ON o.id = wi.organization_id WHERE o.id IS NULL OR o.lifecycle_state <> 'active')
                   OR EXISTS (
                       SELECT 1 FROM workflow_instances wi
                        WHERE wi.branch_id IS NOT NULL
                          AND NOT EXISTS (
                              SELECT 1 FROM campus_assignments ca
                              JOIN branches b ON b.id = ca.branch_id
                              JOIN campuses c ON c.id = ca.campus_id
                              WHERE ca.branch_id = wi.branch_id
                                AND b.lifecycle_state = 'active'
                                AND ca.effective_from <= CURRENT_DATE AND (ca.effective_to IS NULL OR ca.effective_to > CURRENT_DATE)
                                AND c.organization_id = wi.organization_id
                                AND c.lifecycle_state = 'active'
                          )
                   )
                   OR EXISTS (
                       SELECT 1 FROM work_items wi
                        WHERE wi.branch_id IS NOT NULL
                          AND NOT EXISTS (
                              SELECT 1 FROM campus_assignments ca
                              JOIN branches b ON b.id = ca.branch_id
                              JOIN campuses c ON c.id = ca.campus_id
                              WHERE ca.branch_id = wi.branch_id
                                AND b.lifecycle_state = 'active'
                                AND ca.effective_from <= CURRENT_DATE AND (ca.effective_to IS NULL OR ca.effective_to > CURRENT_DATE)
                                AND c.organization_id = wi.organization_id
                                AND c.lifecycle_state = 'active'
                          )
                   )
                   OR EXISTS (
                       SELECT 1
                         FROM work_items wi
                         JOIN workflow_instances wf ON wf.id = wi.workflow_instance_id
                        WHERE wf.branch_id IS DISTINCT FROM wi.branch_id
                           OR wf.organization_id IS DISTINCT FROM wi.organization_id
                   ) THEN
                    RAISE EXCEPTION 'work management migration requires active, matching organization and branch provenance for every existing workflow and work item'
                        USING ERRCODE = 'check_violation';
                END IF;
            END
            $migration$
            SQL);
        DB::statement('ALTER TABLE workflow_instances ALTER COLUMN organization_id SET NOT NULL');
        DB::statement('ALTER TABLE work_items ALTER COLUMN organization_id SET NOT NULL');
        DB::statement("ALTER TABLE workflow_instances ADD CONSTRAINT workflow_instances_scope_check CHECK (btrim(organization_id) <> '')");
        DB::statement("ALTER TABLE work_items ADD CONSTRAINT work_items_scope_check CHECK (btrim(organization_id) <> '')");

        DB::statement(<<<'SQL'
            CREATE OR REPLACE FUNCTION workflow_instances_provenance_guard() RETURNS trigger AS $fn$
            BEGIN
                IF btrim(coalesce(NEW.organization_id, '')) = '' THEN
                    RAISE EXCEPTION 'workflow instances require organization provenance'
                        USING ERRCODE = 'check_violation';
                END IF;
                IF NOT EXISTS (
                    SELECT 1 FROM organizations
                     WHERE id = NEW.organization_id
                       AND lifecycle_state = 'active'
                ) THEN
                    RAISE EXCEPTION 'workflow organization provenance must name an active organization'
                        USING ERRCODE = 'check_violation';
                END IF;
                IF NEW.branch_id IS NOT NULL
                   AND NOT EXISTS (
                       SELECT 1
                         FROM campus_assignments ca
                         JOIN branches b ON b.id = ca.branch_id
                         JOIN campuses c ON c.id = ca.campus_id
                        WHERE ca.branch_id = NEW.branch_id
                          AND b.lifecycle_state = 'active'
                          AND ca.effective_from <= CURRENT_DATE AND (ca.effective_to IS NULL OR ca.effective_to > CURRENT_DATE)
                          AND c.organization_id = NEW.organization_id
                          AND c.lifecycle_state = 'active'
                   ) THEN
                    RAISE EXCEPTION 'workflow branch and organization provenance must identify the same active structure'
                        USING ERRCODE = 'check_violation';
                END IF;
                RETURN NEW;
            END;
            $fn$ LANGUAGE plpgsql;
            SQL);
        DB::statement('CREATE TRIGGER workflow_instances_provenance_trigger BEFORE INSERT OR UPDATE OF branch_id, organization_id ON workflow_instances FOR EACH ROW EXECUTE FUNCTION workflow_instances_provenance_guard()');

        DB::statement(<<<'SQL'
            CREATE OR REPLACE FUNCTION work_items_provenance_guard() RETURNS trigger AS $fn$
            DECLARE
                workflow_branch char(36);
                workflow_organization char(36);
            BEGIN
                IF TG_OP = 'INSERT' AND NEW.lifecycle_state <> 'open' THEN
                    RAISE EXCEPTION 'a work item is born open and must transition through the coordination command'
                        USING ERRCODE = 'check_violation';
                END IF;
                IF btrim(coalesce(NEW.organization_id, '')) = '' THEN
                    RAISE EXCEPTION 'work items require organization provenance'
                        USING ERRCODE = 'check_violation';
                END IF;
                IF NOT EXISTS (
                    SELECT 1 FROM organizations
                     WHERE id = NEW.organization_id
                       AND lifecycle_state = 'active'
                ) THEN
                    RAISE EXCEPTION 'work item organization provenance must name an active organization'
                        USING ERRCODE = 'check_violation';
                END IF;
                IF NEW.branch_id IS NOT NULL
                   AND NOT EXISTS (
                       SELECT 1
                         FROM campus_assignments ca
                         JOIN branches b ON b.id = ca.branch_id
                         JOIN campuses c ON c.id = ca.campus_id
                        WHERE ca.branch_id = NEW.branch_id
                          AND b.lifecycle_state = 'active'
                          AND ca.effective_from <= CURRENT_DATE AND (ca.effective_to IS NULL OR ca.effective_to > CURRENT_DATE)
                          AND c.organization_id = NEW.organization_id
                          AND c.lifecycle_state = 'active'
                   ) THEN
                    RAISE EXCEPTION 'work item branch and organization provenance must identify the same active structure'
                        USING ERRCODE = 'check_violation';
                END IF;
                IF TG_OP = 'UPDATE' THEN
                    IF OLD.workflow_instance_id IS DISTINCT FROM NEW.workflow_instance_id
                       OR OLD.kind IS DISTINCT FROM NEW.kind
                       OR OLD.title IS DISTINCT FROM NEW.title
                       OR OLD.description IS DISTINCT FROM NEW.description
                       OR OLD.source_type IS DISTINCT FROM NEW.source_type
                       OR OLD.source_id IS DISTINCT FROM NEW.source_id
                       OR OLD.action_key IS DISTINCT FROM NEW.action_key
                       OR OLD.source_version IS DISTINCT FROM NEW.source_version
                       OR OLD.branch_id IS DISTINCT FROM NEW.branch_id
                       OR OLD.organization_id IS DISTINCT FROM NEW.organization_id
                       OR OLD.created_by IS DISTINCT FROM NEW.created_by THEN
                        RAISE EXCEPTION 'work item source and provenance terms are immutable'
                            USING ERRCODE = 'check_violation';
                    END IF;
                    IF OLD.lifecycle_state IS DISTINCT FROM NEW.lifecycle_state
                       AND NOT (
                           (OLD.lifecycle_state = 'open' AND NEW.lifecycle_state IN ('claimed', 'in_progress', 'cancelled', 'expired'))
                           OR (OLD.lifecycle_state = 'open' AND NEW.lifecycle_state = 'completed'
                               AND COALESCE(current_setting('app.work_item_source_completion', true), '') = 'on')
                           OR (OLD.lifecycle_state = 'claimed' AND NEW.lifecycle_state IN ('in_progress', 'completed', 'cancelled', 'expired'))
                           OR (OLD.lifecycle_state = 'in_progress' AND NEW.lifecycle_state IN ('completed', 'cancelled', 'expired'))
                       ) THEN
                        RAISE EXCEPTION 'work item lifecycle transition is not governed'
                            USING ERRCODE = 'check_violation';
                    END IF;
                END IF;
                IF NEW.lifecycle_state IN ('completed', 'cancelled', 'expired')
                   AND (NEW.completed_at IS NULL OR NEW.completed_by IS NULL) THEN
                    RAISE EXCEPTION 'terminal work items require completion evidence'
                        USING ERRCODE = 'check_violation';
                END IF;
                IF NEW.lifecycle_state IN ('open', 'claimed', 'in_progress')
                   AND (NEW.completed_at IS NOT NULL OR NEW.completed_by IS NOT NULL) THEN
                    RAISE EXCEPTION 'non-terminal work items cannot carry completion evidence'
                        USING ERRCODE = 'check_violation';
                END IF;
                IF NEW.workflow_instance_id IS NOT NULL THEN
                    SELECT branch_id, organization_id
                      INTO workflow_branch, workflow_organization
                      FROM workflow_instances
                     WHERE id = NEW.workflow_instance_id;
                    IF NOT FOUND
                       OR workflow_branch IS DISTINCT FROM NEW.branch_id
                       OR workflow_organization IS DISTINCT FROM NEW.organization_id THEN
                        RAISE EXCEPTION 'work item branch and organization provenance must match its workflow instance'
                            USING ERRCODE = 'check_violation';
                    END IF;
                END IF;
                RETURN NEW;
            END;
            $fn$ LANGUAGE plpgsql;
            SQL);
        // 000148 created a trigger with this stable name. Replace it after
        // replacing the function so PostgreSQL does not reject a duplicate
        // trigger name during the converged migration.
        DB::statement('DROP TRIGGER IF EXISTS work_items_provenance_trigger ON work_items');
        DB::statement('CREATE TRIGGER work_items_provenance_trigger BEFORE INSERT OR UPDATE ON work_items FOR EACH ROW EXECUTE FUNCTION work_items_provenance_guard()');
    }

    public function down(): void
    {
        // The settled schema carries organization provenance that the 000148
        // shape cannot represent. Refuse a silent downgrade that would erase
        // that evidence; rollback is valid only before governed rows exist.
        DB::statement(<<<'SQL'
            DO $rollback$
            BEGIN
                IF EXISTS (SELECT 1 FROM workflow_instances WHERE organization_id IS NOT NULL)
                   OR EXISTS (SELECT 1 FROM work_items WHERE organization_id IS NOT NULL) THEN
                    RAISE EXCEPTION 'cannot roll back work organization provenance while governed workflow or work-item rows exist; export or reconcile them first'
                        USING ERRCODE = 'check_violation';
                END IF;
            END
            $rollback$
            SQL);
        DB::statement('DROP TRIGGER IF EXISTS workflow_instances_provenance_trigger ON workflow_instances');
        DB::statement('DROP TRIGGER IF EXISTS work_items_provenance_trigger ON work_items');
        DB::statement('DROP FUNCTION IF EXISTS work_items_provenance_guard()');
        DB::statement('DROP FUNCTION IF EXISTS workflow_instances_provenance_guard()');
        DB::statement('ALTER TABLE workflow_instances DROP CONSTRAINT IF EXISTS workflow_instances_scope_check');
        DB::statement('ALTER TABLE work_items DROP CONSTRAINT IF EXISTS work_items_scope_check');
        DB::statement('DROP INDEX IF EXISTS workflow_instances_organization_id_lifecycle_state_index');
        DB::statement('DROP INDEX IF EXISTS work_items_organization_id_lifecycle_state_index');
        Schema::table('work_items', function (Blueprint $table): void {
            $table->dropForeign(['organization_id']);
            $table->dropColumn('organization_id');
        });
        Schema::table('workflow_instances', function (Blueprint $table): void {
            $table->dropForeign(['organization_id']);
            $table->dropColumn('organization_id');
        });
        DB::statement(<<<'SQL'
            CREATE OR REPLACE FUNCTION work_items_provenance_guard() RETURNS trigger AS $fn$
            DECLARE
                workflow_branch char(36);
            BEGIN
                IF TG_OP = 'INSERT' AND NEW.lifecycle_state <> 'open' THEN
                    RAISE EXCEPTION 'a work item is born open and must transition through the coordination command'
                        USING ERRCODE = 'check_violation';
                END IF;
                IF TG_OP = 'UPDATE' THEN
                    IF OLD.workflow_instance_id IS DISTINCT FROM NEW.workflow_instance_id
                       OR OLD.kind IS DISTINCT FROM NEW.kind
                       OR OLD.title IS DISTINCT FROM NEW.title
                       OR OLD.description IS DISTINCT FROM NEW.description
                       OR OLD.source_type IS DISTINCT FROM NEW.source_type
                       OR OLD.source_id IS DISTINCT FROM NEW.source_id
                       OR OLD.action_key IS DISTINCT FROM NEW.action_key
                       OR OLD.source_version IS DISTINCT FROM NEW.source_version
                       OR OLD.branch_id IS DISTINCT FROM NEW.branch_id
                       OR OLD.created_by IS DISTINCT FROM NEW.created_by THEN
                        RAISE EXCEPTION 'work item source and provenance terms are immutable'
                            USING ERRCODE = 'check_violation';
                    END IF;
                    IF OLD.lifecycle_state IS DISTINCT FROM NEW.lifecycle_state
                       AND NOT (
                           (OLD.lifecycle_state = 'open' AND NEW.lifecycle_state IN ('claimed', 'in_progress', 'cancelled', 'expired'))
                           OR (OLD.lifecycle_state = 'claimed' AND NEW.lifecycle_state IN ('in_progress', 'completed', 'cancelled', 'expired'))
                           OR (OLD.lifecycle_state = 'in_progress' AND NEW.lifecycle_state IN ('completed', 'cancelled', 'expired'))
                       ) THEN
                        RAISE EXCEPTION 'work item lifecycle transition is not governed'
                            USING ERRCODE = 'check_violation';
                    END IF;
                END IF;
                IF NEW.lifecycle_state IN ('completed', 'cancelled', 'expired')
                   AND (NEW.completed_at IS NULL OR NEW.completed_by IS NULL) THEN
                    RAISE EXCEPTION 'terminal work items require completion evidence'
                        USING ERRCODE = 'check_violation';
                END IF;
                IF NEW.lifecycle_state IN ('open', 'claimed', 'in_progress')
                   AND (NEW.completed_at IS NOT NULL OR NEW.completed_by IS NOT NULL) THEN
                    RAISE EXCEPTION 'non-terminal work items cannot carry completion evidence'
                        USING ERRCODE = 'check_violation';
                END IF;
                IF NEW.workflow_instance_id IS NOT NULL THEN
                    SELECT branch_id INTO workflow_branch
                      FROM workflow_instances WHERE id = NEW.workflow_instance_id;
                    IF NOT FOUND OR workflow_branch IS DISTINCT FROM NEW.branch_id THEN
                        RAISE EXCEPTION 'work item branch provenance must match its workflow instance'
                            USING ERRCODE = 'check_violation';
                    END IF;
                END IF;
                RETURN NEW;
            END;
            $fn$ LANGUAGE plpgsql;
            SQL);
        DB::statement('CREATE TRIGGER work_items_provenance_trigger BEFORE INSERT OR UPDATE ON work_items FOR EACH ROW EXECUTE FUNCTION work_items_provenance_guard()');
    }
};
