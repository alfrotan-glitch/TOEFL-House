<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Schema;

/**
 * A reporting reconciliation is immutable variance evidence, not an
 * organizationless second report. New evidence must retain the same current,
 * complete projection and target provenance that the reconciliation command
 * actually compared. Earlier rows remain visibly unanchored rather than being
 * assigned reconstructed tenant metadata.
 */
return new class extends Migration
{
    public function up(): void
    {
        Schema::table('metric_reconciliations', function (Blueprint $table): void {
            $table->char('organization_id', 36)->nullable();
            $table->char('metric_projection_id', 36)->nullable();
            $table->foreign('organization_id')->references('id')->on('organizations');
            $table->foreign('metric_projection_id')->references('id')->on('metric_projections');
            $table->index(['organization_id', 'created_at']);
            $table->index('metric_projection_id');
        });

        DB::statement("ALTER TABLE metric_reconciliations ADD CONSTRAINT metric_reconciliations_scope_type_check CHECK (scope_type IN ('global','branch','student','class','fund')) NOT VALID");
        DB::statement(<<<'SQL'
            ALTER TABLE metric_reconciliations
                ADD CONSTRAINT metric_reconciliations_scope_shape_check
                CHECK (
                    (scope_type = 'global' AND scope_id IS NULL AND organization_id IS NULL)
                    OR (scope_type IN ('branch','student','class','fund')
                        AND scope_id IS NOT NULL
                        AND organization_id IS NOT NULL)
                ) NOT VALID
            SQL);
        DB::statement(<<<'SQL'
            ALTER TABLE metric_reconciliations
                ADD CONSTRAINT metric_reconciliations_status_variance_check
                CHECK (
                    (status = 'matched' AND variance = 0)
                    OR (status = 'diverged' AND variance <> 0)
                ) NOT VALID
            SQL);

        DB::statement(<<<'SQL'
            CREATE OR REPLACE FUNCTION metric_reconciliations_provenance_guard() RETURNS trigger AS $fn$
            DECLARE
                resolved_organization char(36);
                resolved_target_count integer := 0;
                projection_metric char(36);
                projection_period text;
                projection_scope_type text;
                projection_scope_id char(36);
                projection_organization char(36);
                projection_value numeric;
                projection_completeness text;
                projection_version_no integer;
                current_version_no integer;
            BEGIN
                IF NEW.scope_type = 'global' THEN
                    IF NEW.scope_id IS NOT NULL OR NEW.organization_id IS NOT NULL THEN
                        RAISE EXCEPTION 'global metric reconciliations require null target and organization provenance'
                            USING ERRCODE = 'check_violation';
                    END IF;
                    resolved_organization := NULL;
                ELSIF NEW.scope_type = 'branch' THEN
                    SELECT count(*), min(c.organization_id)
                      INTO resolved_target_count, resolved_organization
                      FROM branches b
                      JOIN campus_assignments ca
                        ON ca.branch_id = b.id
                       AND ca.effective_from <= CURRENT_DATE
                       AND (ca.effective_to IS NULL OR ca.effective_to > CURRENT_DATE)
                      JOIN campuses c ON c.id = ca.campus_id
                      JOIN organizations o ON o.id = c.organization_id
                     WHERE b.id = NEW.scope_id
                       AND b.lifecycle_state = 'active'
                       AND c.lifecycle_state = 'active'
                       AND o.lifecycle_state = 'active';
                ELSIF NEW.scope_type = 'student' THEN
                    SELECT count(*), min(c.organization_id)
                      INTO resolved_target_count, resolved_organization
                      FROM students s
                      JOIN branches b
                        ON b.id = COALESCE(
                            NULLIF(btrim(s.current_home_branch_id), ''),
                            NULLIF(btrim(s.originating_branch_id), '')
                        )
                      JOIN campus_assignments ca
                        ON ca.branch_id = b.id
                       AND ca.effective_from <= CURRENT_DATE
                       AND (ca.effective_to IS NULL OR ca.effective_to > CURRENT_DATE)
                      JOIN campuses c ON c.id = ca.campus_id
                      JOIN organizations o ON o.id = c.organization_id
                     WHERE s.id = NEW.scope_id
                       AND b.lifecycle_state = 'active'
                       AND c.lifecycle_state = 'active'
                       AND o.lifecycle_state = 'active';
                ELSIF NEW.scope_type = 'class' THEN
                    SELECT count(*), min(c.organization_id)
                      INTO resolved_target_count, resolved_organization
                      FROM classes cls
                      JOIN branches b ON b.id = cls.branch_id
                      JOIN campus_assignments ca
                        ON ca.branch_id = b.id
                       AND ca.effective_from <= CURRENT_DATE
                       AND (ca.effective_to IS NULL OR ca.effective_to > CURRENT_DATE)
                      JOIN campuses c ON c.id = ca.campus_id
                      JOIN organizations o ON o.id = c.organization_id
                     WHERE cls.id = NEW.scope_id
                       AND b.lifecycle_state = 'active'
                       AND c.lifecycle_state = 'active'
                       AND o.lifecycle_state = 'active';
                ELSIF NEW.scope_type = 'fund' THEN
                    SELECT fs.organization_id
                      INTO resolved_organization
                      FROM funding_sources fs
                     WHERE fs.id = NEW.scope_id
                     FOR KEY SHARE;
                    IF resolved_organization IS NULL
                       OR btrim(resolved_organization) = ''
                       OR NOT EXISTS (
                           SELECT 1 FROM organizations o
                            WHERE o.id = resolved_organization
                              AND o.lifecycle_state = 'active'
                       ) THEN
                        resolved_organization := NULL;
                    END IF;
                ELSE
                    RAISE EXCEPTION 'metric reconciliation scope type is not recognized'
                        USING ERRCODE = 'check_violation';
                END IF;

                IF NEW.scope_type NOT IN ('global', 'fund')
                   AND resolved_target_count <> 1 THEN
                    RAISE EXCEPTION 'metric reconciliation target has ambiguous or inactive organization topology'
                        USING ERRCODE = 'check_violation';
                END IF;
                IF NEW.scope_type <> 'global'
                   AND (resolved_organization IS NULL
                        OR btrim(resolved_organization) = ''
                        OR NEW.organization_id IS DISTINCT FROM resolved_organization) THEN
                    RAISE EXCEPTION 'metric reconciliation requires matching active target organization provenance'
                        USING ERRCODE = 'check_violation';
                END IF;

                IF NEW.metric_projection_id IS NULL THEN
                    RAISE EXCEPTION 'metric reconciliation requires the compared current projection'
                        USING ERRCODE = 'check_violation';
                END IF;
                SELECT mv.metric_id,
                       mp.period_key,
                       mp.scope_type,
                       mp.scope_id,
                       mp.organization_id,
                       mp.value,
                       mp.completeness,
                       mv.version_no,
                       md.current_version
                  INTO projection_metric,
                       projection_period,
                       projection_scope_type,
                       projection_scope_id,
                       projection_organization,
                       projection_value,
                       projection_completeness,
                       projection_version_no,
                       current_version_no
                  FROM metric_projections mp
                  JOIN metric_versions mv ON mv.id = mp.metric_version_id
                  JOIN metric_definitions md ON md.id = mv.metric_id
                 WHERE mp.id = NEW.metric_projection_id
                 FOR KEY SHARE OF mp;
                IF projection_metric IS NULL
                   OR projection_metric IS DISTINCT FROM NEW.metric_id
                   OR projection_period IS DISTINCT FROM NEW.period_key
                   OR projection_scope_type IS DISTINCT FROM NEW.scope_type
                   OR projection_scope_id IS DISTINCT FROM NEW.scope_id
                   OR projection_organization IS DISTINCT FROM NEW.organization_id
                   OR projection_value IS DISTINCT FROM NEW.reported_value
                   OR projection_completeness IS DISTINCT FROM 'complete'
                   OR projection_version_no IS DISTINCT FROM current_version_no THEN
                    RAISE EXCEPTION 'metric reconciliation must reference the matching complete current projection'
                        USING ERRCODE = 'check_violation';
                END IF;

                RETURN NEW;
            END;
            $fn$ LANGUAGE plpgsql;
            SQL);
        DB::statement('DROP TRIGGER IF EXISTS metric_reconciliations_provenance_guard_trigger ON metric_reconciliations');
        DB::statement('CREATE TRIGGER metric_reconciliations_provenance_guard_trigger BEFORE INSERT ON metric_reconciliations FOR EACH ROW EXECUTE FUNCTION metric_reconciliations_provenance_guard()');
    }

    public function down(): void
    {
        // Reconciliation evidence without its compared projection and tenant
        // anchor cannot be safely reconstructed after downgrade.
        throw new \RuntimeException('Metric-reconciliation provenance convergence is one-way; do not erase linked reporting evidence.');
    }
};
