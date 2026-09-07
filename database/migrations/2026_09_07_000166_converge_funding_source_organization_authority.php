<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Schema;

/**
 * Funding-source organization convergence.
 *
 * A fund is a Finance-owned monetary subledger/dimension, not a global pool.
 * The earlier table carried an agreement and restriction but no organization
 * provenance, so an organization-A source could be allocated to an
 * organization-B obligation by either the command or raw SQL. Historic
 * sources remain visibly unknown rather than being assigned to an invented
 * organization; only newly created sources must carry verified provenance.
 */
return new class extends Migration
{
    public function up(): void
    {
        Schema::table('funding_sources', function (Blueprint $table): void {
            // Nullable preserves historical rows without fabricating a tenant
            // assignment. The INSERT guard below makes it mandatory for all
            // new Finance funding facts.
            $table->char('organization_id', 36)->nullable();
            $table->foreign('organization_id')->references('id')->on('organizations');
            $table->index(['organization_id', 'created_at']);
        });

        DB::statement(<<<'SQL'
            CREATE OR REPLACE FUNCTION funding_sources_organization_guard() RETURNS trigger AS $fn$
            BEGIN
                IF NEW.organization_id IS NULL
                   OR btrim(NEW.organization_id) = ''
                   OR NOT EXISTS (
                       SELECT 1
                         FROM organizations o
                        WHERE o.id = NEW.organization_id
                          AND o.lifecycle_state = 'active'
                   ) THEN
                    RAISE EXCEPTION 'a new funding source requires an active organization provenance'
                        USING ERRCODE = 'check_violation';
                END IF;

                RETURN NEW;
            END;
            $fn$ LANGUAGE plpgsql;
            SQL);
        DB::statement('DROP TRIGGER IF EXISTS funding_sources_organization_guard_trigger ON funding_sources');
        DB::statement('CREATE TRIGGER funding_sources_organization_guard_trigger BEFORE INSERT ON funding_sources FOR EACH ROW EXECUTE FUNCTION funding_sources_organization_guard()');

        DB::statement(<<<'SQL'
            CREATE OR REPLACE FUNCTION fund_allocations_organization_guard() RETURNS trigger AS $fn$
            DECLARE
                fund_organization char(36);
                obligation_branch char(36);
                obligation_organization char(36);
            BEGIN
                SELECT fs.organization_id
                  INTO fund_organization
                  FROM funding_sources fs
                 WHERE fs.id = NEW.fund_id
                 FOR KEY SHARE;
                IF fund_organization IS NULL
                   OR btrim(fund_organization) = ''
                   OR NOT EXISTS (
                       SELECT 1
                         FROM organizations o
                        WHERE o.id = fund_organization
                          AND o.lifecycle_state = 'active'
                   ) THEN
                    RAISE EXCEPTION 'fund allocation requires a funding source with active organization provenance'
                        USING ERRCODE = 'check_violation';
                END IF;

                SELECT COALESCE(
                           NULLIF(btrim(ob.current_home_branch_id), ''),
                           NULLIF(btrim(ob.originating_branch_id), '')
                       )
                  INTO obligation_branch
                  FROM obligation_lines ol
                  JOIN obligations ob ON ob.id = ol.obligation_id
                 WHERE ol.id = NEW.obligation_line_id;
                IF obligation_branch IS NULL OR btrim(obligation_branch) = '' THEN
                    RAISE EXCEPTION 'fund allocation requires known obligation branch provenance'
                        USING ERRCODE = 'check_violation';
                END IF;

                SELECT c.organization_id
                  INTO obligation_organization
                  FROM branches b
                  JOIN campus_assignments ca
                    ON ca.branch_id = b.id
                   AND ca.effective_from <= CURRENT_DATE
                   AND (ca.effective_to IS NULL OR ca.effective_to > CURRENT_DATE)
                  JOIN campuses c ON c.id = ca.campus_id
                  JOIN organizations o ON o.id = c.organization_id
                 WHERE b.id = obligation_branch
                   AND b.lifecycle_state = 'active'
                   AND c.lifecycle_state = 'active'
                   AND o.lifecycle_state = 'active';
                IF obligation_organization IS NULL
                   OR btrim(obligation_organization) = '' THEN
                    RAISE EXCEPTION 'fund allocation requires active obligation organization provenance'
                        USING ERRCODE = 'check_violation';
                END IF;
                IF fund_organization IS DISTINCT FROM obligation_organization THEN
                    RAISE EXCEPTION 'fund allocation organization must match its obligation organization'
                        USING ERRCODE = 'check_violation';
                END IF;

                RETURN NEW;
            END;
            $fn$ LANGUAGE plpgsql;
            SQL);
        DB::statement('DROP TRIGGER IF EXISTS fund_allocations_organization_guard_trigger ON fund_allocations');
        DB::statement('CREATE TRIGGER fund_allocations_organization_guard_trigger BEFORE INSERT ON fund_allocations FOR EACH ROW EXECUTE FUNCTION fund_allocations_organization_guard()');

        // A fund-allocation reversal is a new monetary fact, not a harmless
        // edit of history. It may not extend the effect of a legacy source
        // whose tenant is unknown or of an old cross-organization allocation.
        DB::statement(<<<'SQL'
            CREATE OR REPLACE FUNCTION financial_corrections_fund_organization_guard() RETURNS trigger AS $fn$
            DECLARE
                fund_organization char(36);
                obligation_branch char(36);
                obligation_organization char(36);
            BEGIN
                IF NEW.correction_type <> 'fund_allocation_reversal' THEN
                    RETURN NEW;
                END IF;

                SELECT fs.organization_id
                  INTO fund_organization
                  FROM fund_allocations fa
                  JOIN funding_sources fs ON fs.id = fa.fund_id
                 WHERE fa.id = NEW.fund_allocation_id
                 FOR KEY SHARE OF fs;
                IF fund_organization IS NULL
                   OR btrim(fund_organization) = ''
                   OR NOT EXISTS (
                       SELECT 1 FROM organizations o
                        WHERE o.id = fund_organization
                          AND o.lifecycle_state = 'active'
                   ) THEN
                    RAISE EXCEPTION 'fund allocation corrections require active funding-source organization provenance'
                        USING ERRCODE = 'check_violation';
                END IF;

                SELECT COALESCE(
                           NULLIF(btrim(ob.current_home_branch_id), ''),
                           NULLIF(btrim(ob.originating_branch_id), '')
                       )
                  INTO obligation_branch
                  FROM fund_allocations fa
                  JOIN obligation_lines ol ON ol.id = fa.obligation_line_id
                  JOIN obligations ob ON ob.id = ol.obligation_id
                 WHERE fa.id = NEW.fund_allocation_id;
                IF obligation_branch IS NULL OR btrim(obligation_branch) = '' THEN
                    RAISE EXCEPTION 'fund allocation corrections require known obligation branch provenance'
                        USING ERRCODE = 'check_violation';
                END IF;

                SELECT c.organization_id
                  INTO obligation_organization
                  FROM branches b
                  JOIN campus_assignments ca
                    ON ca.branch_id = b.id
                   AND ca.effective_from <= CURRENT_DATE
                   AND (ca.effective_to IS NULL OR ca.effective_to > CURRENT_DATE)
                  JOIN campuses c ON c.id = ca.campus_id
                  JOIN organizations o ON o.id = c.organization_id
                 WHERE b.id = obligation_branch
                   AND b.lifecycle_state = 'active'
                   AND c.lifecycle_state = 'active'
                   AND o.lifecycle_state = 'active';
                IF obligation_organization IS NULL
                   OR btrim(obligation_organization) = ''
                   OR fund_organization IS DISTINCT FROM obligation_organization THEN
                    RAISE EXCEPTION 'fund allocation correction organization must match its obligation organization'
                        USING ERRCODE = 'check_violation';
                END IF;

                RETURN NEW;
            END;
            $fn$ LANGUAGE plpgsql;
            SQL);
        DB::statement('DROP TRIGGER IF EXISTS financial_corrections_fund_organization_guard_trigger ON financial_corrections');
        DB::statement('CREATE TRIGGER financial_corrections_fund_organization_guard_trigger BEFORE INSERT OR UPDATE OF correction_type, fund_allocation_id, lifecycle_state ON financial_corrections FOR EACH ROW EXECUTE FUNCTION financial_corrections_fund_organization_guard()');
    }

    public function down(): void
    {
        // Removing this boundary would make current, organization-bound fund
        // sources allocatable across tenants again. It is intentionally
        // forward-only; restore a reviewed pre-convergence snapshot instead.
        throw new \RuntimeException('Funding source organization convergence is one-way; do not erase Finance tenant provenance or reopen cross-organization allocation.');
    }
};
