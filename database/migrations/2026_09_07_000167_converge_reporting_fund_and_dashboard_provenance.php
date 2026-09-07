<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Support\Facades\DB;

/**
 * Completes the Finance-fund tenant boundary in Reporting and Dashboard.
 *
 * Fund records created before 000166 have no trustworthy organization. They
 * remain visibly unknown: this migration does not manufacture a backfill.
 * NOT VALID checks govern new/changed rows while preserving those historical
 * facts for separately auditable reconciliation.
 */
return new class extends Migration
{
    public function up(): void
    {
        // Existing historical fund runs/projections can have a null or wrong
        // snapshot. Do not mutate immutable report evidence to make it look
        // tenant-safe. PostgreSQL applies NOT VALID CHECKs to all future
        // INSERTs and relevant UPDATEs without inventing legacy provenance.
        DB::statement("ALTER TABLE report_runs ADD CONSTRAINT report_runs_fund_organization_check CHECK (scope_type <> 'fund' OR organization_id IS NOT NULL) NOT VALID");
        // A historical unknown fund slice may be moved only into the safe
        // withheld (`stale` or `incomplete`) state. This lets a later metric revision withhold it without
        // relabeling the old snapshot as tenant-safe; the trigger below still
        // rejects every new fund slice without matching source provenance.
        DB::statement("ALTER TABLE metric_projections ADD CONSTRAINT metric_projections_fund_organization_check CHECK (scope_type <> 'fund' OR organization_id IS NOT NULL OR completeness IN ('stale', 'incomplete')) NOT VALID");

        DB::statement(<<<'SQL'
            CREATE OR REPLACE FUNCTION report_runs_fund_organization_guard() RETURNS trigger AS $fn$
            DECLARE
                fund_organization char(36);
            BEGIN
                IF NEW.scope_type <> 'fund' THEN
                    RETURN NEW;
                END IF;

                SELECT fs.organization_id
                  INTO fund_organization
                  FROM funding_sources fs
                 WHERE fs.id = NEW.scope_id
                 FOR KEY SHARE;
                IF fund_organization IS NULL
                   OR btrim(fund_organization) = ''
                   OR NOT EXISTS (
                       SELECT 1 FROM organizations o
                        WHERE o.id = fund_organization
                          AND o.lifecycle_state = 'active'
                   ) THEN
                    RAISE EXCEPTION 'fund report runs require active funding-source organization provenance'
                        USING ERRCODE = 'check_violation';
                END IF;
                IF NEW.organization_id IS DISTINCT FROM fund_organization THEN
                    RAISE EXCEPTION 'fund report run organization must match its funding source'
                        USING ERRCODE = 'check_violation';
                END IF;

                RETURN NEW;
            END;
            $fn$ LANGUAGE plpgsql;
            SQL);
        DB::statement('DROP TRIGGER IF EXISTS report_runs_fund_organization_guard_trigger ON report_runs');
        // report_runs are immutable after insertion; only new report evidence
        // can be written, so an INSERT guard is both sufficient and avoids
        // treating historical rows as if they were rewritten.
        DB::statement('CREATE TRIGGER report_runs_fund_organization_guard_trigger BEFORE INSERT ON report_runs FOR EACH ROW EXECUTE FUNCTION report_runs_fund_organization_guard()');

        DB::statement(<<<'SQL'
            CREATE OR REPLACE FUNCTION metric_projections_fund_organization_guard() RETURNS trigger AS $fn$
            DECLARE
                fund_organization char(36);
                source_provenance_active boolean;
                old_snapshot_matches_source boolean;
            BEGIN
                IF NEW.scope_type <> 'fund' THEN
                    RETURN NEW;
                END IF;

                SELECT fs.organization_id
                  INTO fund_organization
                  FROM funding_sources fs
                 WHERE fs.id = NEW.scope_id
                 FOR KEY SHARE;
                source_provenance_active := fund_organization IS NOT NULL
                    AND btrim(fund_organization) <> ''
                    AND EXISTS (
                        SELECT 1 FROM organizations o
                         WHERE o.id = fund_organization
                           AND o.lifecycle_state = 'active'
                    );

                IF TG_OP = 'UPDATE' AND OLD.scope_type = 'fund' THEN
                    old_snapshot_matches_source := source_provenance_active
                        AND OLD.scope_id IS NOT DISTINCT FROM NEW.scope_id
                        AND OLD.organization_id IS NOT DISTINCT FROM fund_organization;
                    IF NOT old_snapshot_matches_source THEN
                        // Preserve an old unknown/wrong snapshot exactly. A
                        // version revision may only make it stale; it cannot
                        // repair its organization, value, or evidence in
                        // place and thereby rewrite history.
                        IF OLD.metric_version_id IS NOT DISTINCT FROM NEW.metric_version_id
                           AND OLD.period_key IS NOT DISTINCT FROM NEW.period_key
                           AND OLD.scope_type IS NOT DISTINCT FROM NEW.scope_type
                           AND OLD.scope_id IS NOT DISTINCT FROM NEW.scope_id
                           AND OLD.organization_id IS NOT DISTINCT FROM NEW.organization_id
                           AND OLD.value IS NOT DISTINCT FROM NEW.value
                           AND OLD.meta IS NOT DISTINCT FROM NEW.meta
                           AND OLD.computed_at IS NOT DISTINCT FROM NEW.computed_at
                           AND OLD.computed_by IS NOT DISTINCT FROM NEW.computed_by
                           AND OLD.created_at IS NOT DISTINCT FROM NEW.created_at
                           AND OLD.completeness NOT IN ('stale', 'incomplete')
                           AND NEW.completeness IN ('stale', 'incomplete') THEN
                            RETURN NEW;
                        END IF;
                        RAISE EXCEPTION 'historical fund metric projection provenance is unresolved and may only be marked stale'
                            USING ERRCODE = 'check_violation';
                    END IF;
                END IF;

                IF NOT source_provenance_active THEN
                    RAISE EXCEPTION 'fund metric projections require active funding-source organization provenance'
                        USING ERRCODE = 'check_violation';
                END IF;
                IF NEW.organization_id IS DISTINCT FROM fund_organization THEN
                    RAISE EXCEPTION 'fund metric projection organization must match its funding source'
                        USING ERRCODE = 'check_violation';
                END IF;

                RETURN NEW;
            END;
            $fn$ LANGUAGE plpgsql;
            SQL);
        DB::statement('DROP TRIGGER IF EXISTS metric_projections_fund_organization_guard_trigger ON metric_projections');
        DB::statement('CREATE TRIGGER metric_projections_fund_organization_guard_trigger BEFORE INSERT OR UPDATE ON metric_projections FOR EACH ROW EXECUTE FUNCTION metric_projections_fund_organization_guard()');

        // Replace the existing pin-scope guard rather than layering a
        // competing definition. The old branch/student/class rules remain;
        // Finance's immutable source organization is now the fund rule.
        DB::statement(<<<'SQL'
            CREATE OR REPLACE FUNCTION dashboard_pins_provenance_guard() RETURNS trigger AS $fn$
            DECLARE
                dashboard_organization char(36);
                fund_organization char(36);
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
                IF NEW.scope_type = 'fund' THEN
                    SELECT fs.organization_id
                      INTO fund_organization
                      FROM funding_sources fs
                     WHERE fs.id = NEW.scope_id
                     FOR KEY SHARE;
                    IF fund_organization IS NULL
                       OR btrim(fund_organization) = ''
                       OR NOT EXISTS (
                           SELECT 1 FROM organizations o
                            WHERE o.id = fund_organization
                              AND o.lifecycle_state = 'active'
                       )
                       OR fund_organization IS DISTINCT FROM dashboard_organization THEN
                        RAISE EXCEPTION 'fund dashboard pins require funding-source provenance inside the dashboard organization'
                            USING ERRCODE = 'check_violation';
                    END IF;
                END IF;
                RETURN NEW;
            END;
            $fn$ LANGUAGE plpgsql;
            SQL);

        // A pin is only an index into a projection, not its own analytical
        // value. Require the current complete projection itself to carry the
        // same organization as the owning dashboard. This closes direct-SQL
        // bypasses for fund, student, class, and branch pins; a null/global
        // slice cannot masquerade as an organization dashboard result.
        DB::statement(<<<'SQL'
            CREATE OR REPLACE FUNCTION dashboard_pins_projection_organization_guard() RETURNS trigger AS $fn$
            DECLARE
                dashboard_organization char(36);
            BEGIN
                SELECT organization_id INTO dashboard_organization
                  FROM dashboards
                 WHERE id = NEW.dashboard_id
                 FOR KEY SHARE;
                IF dashboard_organization IS NULL OR btrim(dashboard_organization) = '' THEN
                    RAISE EXCEPTION 'dashboard pin requires an organization-owned dashboard'
                        USING ERRCODE = 'check_violation';
                END IF;
                IF NEW.scope_type = 'global' THEN
                    RAISE EXCEPTION 'organization-owned dashboards cannot pin global projections'
                        USING ERRCODE = 'check_violation';
                END IF;

                IF NOT EXISTS (
                    SELECT 1
                      FROM metric_definitions md
                      JOIN metric_versions mv
                        ON mv.metric_id = md.id
                       AND mv.version_no = md.current_version
                      JOIN metric_projections mp
                        ON mp.metric_version_id = mv.id
                     WHERE md.id = NEW.metric_id
                       AND mp.period_key = NEW.period_key
                       AND mp.scope_type = NEW.scope_type
                       AND ((NEW.scope_id IS NULL AND mp.scope_id IS NULL) OR mp.scope_id = NEW.scope_id)
                       AND mp.completeness = 'complete'
                       AND mp.organization_id = dashboard_organization
                ) THEN
                    RAISE EXCEPTION 'dashboard pins require a complete projection matching the dashboard organization'
                        USING ERRCODE = 'check_violation';
                END IF;

                RETURN NEW;
            END;
            $fn$ LANGUAGE plpgsql;
            SQL);
        DB::statement('DROP TRIGGER IF EXISTS dashboard_pins_projection_organization_guard_trigger ON dashboard_pins');
        DB::statement('CREATE TRIGGER dashboard_pins_projection_organization_guard_trigger BEFORE INSERT ON dashboard_pins FOR EACH ROW EXECUTE FUNCTION dashboard_pins_projection_organization_guard()');
    }

    public function down(): void
    {
        // Historical null snapshots deliberately remain unknown. Dropping the
        // guards would reopen a cross-organization reporting disclosure path,
        // so this convergence migration is intentionally forward-only.
        throw new \RuntimeException('Reporting fund and dashboard provenance convergence is one-way; do not erase tenant-bound reporting safeguards.');
    }
};
