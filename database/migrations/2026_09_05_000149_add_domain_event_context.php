<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Schema;

/** Explicit event-envelope provenance; unknown never means wildcard scope. */
return new class extends Migration
{
    public function up(): void
    {
        Schema::table('domain_events', function ($table): void {
            $table->jsonb('context')->nullable();
        });
        DB::statement("UPDATE domain_events SET context = jsonb_build_object('scope_type', 'unknown', 'scope_provenance', 'not_available') WHERE context IS NULL");
        DB::statement("ALTER TABLE domain_events ALTER COLUMN context SET DEFAULT '{\"scope_type\":\"unknown\",\"scope_provenance\":\"not_available\"}'::jsonb");
        DB::statement('ALTER TABLE domain_events ALTER COLUMN context SET NOT NULL');
        DB::statement(<<<'SQL'
            ALTER TABLE domain_events ADD CONSTRAINT domain_events_context_check CHECK (
                jsonb_typeof(context) = 'object'
                AND context ? 'scope_type'
                AND COALESCE(jsonb_typeof(context->'scope_type') = 'string', false)
                AND btrim(context->>'scope_type') IN ('branch', 'organization', 'unknown')
                AND context ? 'scope_provenance'
                AND COALESCE(jsonb_typeof(context->'scope_provenance') = 'string', false)
                AND btrim(context->>'scope_provenance') IN ('declared_on_audited_change', 'not_available')
                AND (
                    (context->>'scope_type' = 'unknown' AND context->>'scope_provenance' = 'not_available')
                    OR (context->>'scope_type' IN ('branch', 'organization') AND context->>'scope_provenance' = 'declared_on_audited_change')
                )
                AND (
                    (context->>'scope_type' = 'branch'
                        AND btrim(coalesce(context->>'branch_id', '')) <> ''
                        AND btrim(coalesce(context->>'organization_id', '')) <> '')
                    OR (context->>'scope_type' = 'organization'
                        AND btrim(coalesce(context->>'organization_id', '')) <> ''
                        AND btrim(coalesce(context->>'branch_id', '')) = '')
                    OR context->>'scope_type' = 'unknown'
                )
            )
            SQL);

        DB::statement("CREATE INDEX domain_events_context_branch_idx ON domain_events ((context->>'branch_id')) WHERE context ? 'branch_id'");
        DB::statement(<<<'SQL'
            CREATE OR REPLACE FUNCTION domain_events_context_provenance_guard() RETURNS trigger AS $fn$
            BEGIN
                IF NEW.context->>'scope_type' = 'branch'
                   AND NOT EXISTS (
                       SELECT 1 FROM branches
                        WHERE id = NEW.context->>'branch_id'
                          AND lifecycle_state = 'active'
                   ) THEN
                    RAISE EXCEPTION 'domain event branch context must name an active branch'
                        USING ERRCODE = 'check_violation';
                END IF;
                IF NEW.context->>'scope_type' = 'branch'
                   AND NOT EXISTS (
                       SELECT 1
                         FROM campus_assignments ca
                         JOIN campuses c ON c.id = ca.campus_id
                         JOIN organizations o ON o.id = c.organization_id
                        WHERE ca.branch_id = NEW.context->>'branch_id'
                          AND ca.effective_from <= CURRENT_DATE AND (ca.effective_to IS NULL OR ca.effective_to > CURRENT_DATE)
                          AND c.organization_id = NEW.context->>'organization_id'
                          AND c.lifecycle_state = 'active'
                          AND o.lifecycle_state = 'active'
                   ) THEN
                    RAISE EXCEPTION 'domain event branch and organization context must identify the same active structure'
                        USING ERRCODE = 'check_violation';
                END IF;
                IF NEW.context->>'scope_type' = 'organization'
                   AND NOT EXISTS (
                       SELECT 1 FROM organizations
                        WHERE id = NEW.context->>'organization_id'
                          AND lifecycle_state = 'active'
                   ) THEN
                    RAISE EXCEPTION 'domain event organization context must name an active organization'
                        USING ERRCODE = 'check_violation';
                END IF;
                RETURN NEW;
            END;
            $fn$ LANGUAGE plpgsql;
            SQL);
        DB::statement('CREATE TRIGGER domain_events_context_provenance_trigger BEFORE INSERT ON domain_events FOR EACH ROW EXECUTE FUNCTION domain_events_context_provenance_guard()');
    }

    public function down(): void
    {
        DB::statement('DROP TRIGGER IF EXISTS domain_events_context_provenance_trigger ON domain_events');
        DB::statement('DROP FUNCTION IF EXISTS domain_events_context_provenance_guard()');
        DB::statement('DROP INDEX IF EXISTS domain_events_context_branch_idx');
        DB::statement('ALTER TABLE domain_events DROP CONSTRAINT IF EXISTS domain_events_context_check');
        Schema::table('domain_events', function ($table): void {
            $table->dropColumn('context');
        });
    }
};
