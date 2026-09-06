<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Schema;

/** Rebuildable metric slices preserve organization provenance for branch scope. */
return new class extends Migration
{
    public function up(): void
    {
        Schema::table('metric_projections', function (Blueprint $table): void {
            $table->char('organization_id', 36)->nullable();
            $table->foreign('organization_id')->references('id')->on('organizations');
            $table->index(['organization_id', 'scope_type']);
        });
        DB::statement('ALTER TABLE metric_projections DROP CONSTRAINT IF EXISTS metric_projections_scope_type_check');
        DB::statement("ALTER TABLE metric_projections ADD CONSTRAINT metric_projections_scope_type_check CHECK (scope_type IN ('global','student','class','fund','branch'))");
        DB::statement(<<<'SQL'
            UPDATE metric_projections mp
               SET organization_id = c.organization_id
              FROM campus_assignments ca
              JOIN branches b ON b.id = ca.branch_id
              JOIN campuses c ON c.id = ca.campus_id
              JOIN organizations o ON o.id = c.organization_id
             WHERE mp.scope_type = 'branch'
               AND mp.scope_id = ca.branch_id
               AND b.lifecycle_state = 'active'
               AND c.lifecycle_state = 'active'
               AND o.lifecycle_state = 'active'
               AND ca.effective_from <= CURRENT_DATE AND (ca.effective_to IS NULL OR ca.effective_to > CURRENT_DATE)
               AND mp.organization_id IS NULL
            SQL);
        DB::statement(<<<'SQL'
            UPDATE metric_projections mp
               SET organization_id = c.organization_id
              FROM students s
              JOIN branches b ON b.id = COALESCE(NULLIF(btrim(s.current_home_branch_id), ''), NULLIF(btrim(s.originating_branch_id), ''))
              JOIN campus_assignments ca ON ca.branch_id = b.id AND ca.effective_from <= CURRENT_DATE AND (ca.effective_to IS NULL OR ca.effective_to > CURRENT_DATE)
              JOIN campuses c ON c.id = ca.campus_id
              JOIN organizations o ON o.id = c.organization_id
             WHERE mp.scope_type = 'student'
               AND mp.scope_id = s.id
               AND b.lifecycle_state = 'active'
               AND c.lifecycle_state = 'active'
               AND o.lifecycle_state = 'active'
               AND mp.organization_id IS NULL
            SQL);
        DB::statement(<<<'SQL'
            UPDATE metric_projections mp
               SET organization_id = c.organization_id
              FROM classes cls
              JOIN branches b ON b.id = cls.branch_id
              JOIN campus_assignments ca ON ca.branch_id = b.id AND ca.effective_from <= CURRENT_DATE AND (ca.effective_to IS NULL OR ca.effective_to > CURRENT_DATE)
              JOIN campuses c ON c.id = ca.campus_id
              JOIN organizations o ON o.id = c.organization_id
             WHERE mp.scope_type = 'class'
               AND mp.scope_id = cls.id
               AND b.lifecycle_state = 'active'
               AND c.lifecycle_state = 'active'
               AND o.lifecycle_state = 'active'
               AND mp.organization_id IS NULL
            SQL);
        DB::statement(<<<'SQL'
            DO $migration$
            BEGIN
                IF EXISTS (SELECT 1 FROM metric_projections WHERE scope_type IN ('branch', 'student', 'class') AND organization_id IS NULL)
                   OR EXISTS (
                       SELECT 1 FROM metric_projections mp
                        WHERE mp.scope_type = 'branch'
                          AND NOT EXISTS (
                              SELECT 1
                                FROM campus_assignments ca
                                JOIN branches b ON b.id = ca.branch_id
                                JOIN campuses c ON c.id = ca.campus_id
                                JOIN organizations o ON o.id = c.organization_id
                               WHERE ca.branch_id = mp.scope_id
                                 AND b.lifecycle_state = 'active'
                                 AND ca.effective_from <= CURRENT_DATE AND (ca.effective_to IS NULL OR ca.effective_to > CURRENT_DATE)
                                 AND c.organization_id = mp.organization_id
                                 AND c.lifecycle_state = 'active'
                                 AND o.lifecycle_state = 'active'
                          )
                   )
                   OR EXISTS (
                       SELECT 1 FROM metric_projections mp
                        WHERE mp.scope_type = 'student'
                          AND NOT EXISTS (
                              SELECT 1
                                FROM students s
                                JOIN branches b ON b.id = COALESCE(NULLIF(btrim(s.current_home_branch_id), ''), NULLIF(btrim(s.originating_branch_id), ''))
                                JOIN campus_assignments ca ON ca.branch_id = b.id AND ca.effective_from <= CURRENT_DATE AND (ca.effective_to IS NULL OR ca.effective_to > CURRENT_DATE)
                                JOIN campuses c ON c.id = ca.campus_id
                                JOIN organizations o ON o.id = c.organization_id
                               WHERE s.id = mp.scope_id
                                 AND b.lifecycle_state = 'active'
                                 AND c.organization_id = mp.organization_id
                                 AND c.lifecycle_state = 'active'
                                 AND o.lifecycle_state = 'active'
                          )
                   )
                   OR EXISTS (
                       SELECT 1 FROM metric_projections mp
                        WHERE mp.scope_type = 'class'
                          AND NOT EXISTS (
                              SELECT 1
                                FROM classes cls
                                JOIN branches b ON b.id = cls.branch_id
                                JOIN campus_assignments ca ON ca.branch_id = b.id AND ca.effective_from <= CURRENT_DATE AND (ca.effective_to IS NULL OR ca.effective_to > CURRENT_DATE)
                                JOIN campuses c ON c.id = ca.campus_id
                                JOIN organizations o ON o.id = c.organization_id
                               WHERE cls.id = mp.scope_id
                                 AND b.lifecycle_state = 'active'
                                 AND c.organization_id = mp.organization_id
                                 AND c.lifecycle_state = 'active'
                                 AND o.lifecycle_state = 'active'
                          )
                   ) THEN
                    RAISE EXCEPTION 'metric projection migration requires active, matching branch, student, and class organization provenance'
                        USING ERRCODE = 'check_violation';
                END IF;
            END
            $migration$
            SQL);
        DB::statement("ALTER TABLE metric_projections ADD CONSTRAINT metric_projections_branch_organization_check CHECK (scope_type NOT IN ('branch', 'student', 'class') OR organization_id IS NOT NULL)");
        DB::statement(<<<'SQL'
            CREATE OR REPLACE FUNCTION metric_projections_provenance_guard() RETURNS trigger AS $fn$
            BEGIN
                IF NEW.scope_type = 'branch'
                   AND NOT EXISTS (
                       SELECT 1
                         FROM branches b
                         JOIN campus_assignments ca ON ca.branch_id = b.id AND ca.effective_from <= CURRENT_DATE AND (ca.effective_to IS NULL OR ca.effective_to > CURRENT_DATE)
                         JOIN campuses c ON c.id = ca.campus_id
                         JOIN organizations o ON o.id = c.organization_id
                        WHERE b.id = NEW.scope_id
                          AND b.lifecycle_state = 'active'
                          AND c.organization_id = NEW.organization_id
                          AND c.lifecycle_state = 'active'
                          AND o.lifecycle_state = 'active'
                   ) THEN
                    RAISE EXCEPTION 'branch metric projections require matching active organization provenance'
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
                          AND c.organization_id = NEW.organization_id
                          AND c.lifecycle_state = 'active'
                          AND o.lifecycle_state = 'active'
                   ) THEN
                    RAISE EXCEPTION 'student metric projections require matching active organization provenance'
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
                          AND c.organization_id = NEW.organization_id
                          AND c.lifecycle_state = 'active'
                          AND o.lifecycle_state = 'active'
                   ) THEN
                    RAISE EXCEPTION 'class metric projections require matching active organization provenance'
                        USING ERRCODE = 'check_violation';
                END IF;
                RETURN NEW;
            END;
            $fn$ LANGUAGE plpgsql;
            SQL);
        DB::statement('CREATE TRIGGER metric_projections_provenance_trigger BEFORE INSERT OR UPDATE OF scope_type, scope_id, organization_id ON metric_projections FOR EACH ROW EXECUTE FUNCTION metric_projections_provenance_guard()');
    }

    public function down(): void
    {
        // The pre-000155 schema cannot represent branch slices or their
        // organization snapshot. Refuse any destructive downgrade while
        // governed projection evidence remains.
        DB::statement(<<<'SQL'
            DO $rollback$
            BEGIN
                IF EXISTS (SELECT 1 FROM metric_projections WHERE scope_type = 'branch')
                   OR EXISTS (SELECT 1 FROM metric_projections WHERE organization_id IS NOT NULL) THEN
                    RAISE EXCEPTION 'cannot roll back metric projection scope provenance while branch or organization-scoped slices exist; export or reconcile them first'
                        USING ERRCODE = 'check_violation';
                END IF;
            END
            $rollback$
            SQL);
        DB::statement('DROP TRIGGER IF EXISTS metric_projections_provenance_trigger ON metric_projections');
        DB::statement('DROP FUNCTION IF EXISTS metric_projections_provenance_guard()');
        DB::statement('ALTER TABLE metric_projections DROP CONSTRAINT IF EXISTS metric_projections_branch_organization_check');
        DB::statement('ALTER TABLE metric_projections DROP CONSTRAINT IF EXISTS metric_projections_scope_type_check');
        DB::statement("ALTER TABLE metric_projections ADD CONSTRAINT metric_projections_scope_type_check CHECK (scope_type IN ('global','student','class','fund'))");
        DB::statement('DROP INDEX IF EXISTS metric_projections_organization_id_scope_type_index');
        Schema::table('metric_projections', function (Blueprint $table): void {
            $table->dropForeign(['organization_id']);
            $table->dropColumn('organization_id');
        });
    }
};
