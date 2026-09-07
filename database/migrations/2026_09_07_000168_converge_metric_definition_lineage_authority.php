<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Schema;

/**
 * Separates an immutable historical owner claim from the canonical source
 * authority used by the live Reporting catalog.
 *
 * Earlier definitions recorded `funding` and `academic_delivery` as owners
 * for facts whose canonical authorities are Finance and Enrollment. Those
 * claims are evidence and must not be overwritten. This migration preserves
 * them in `source_owner`, records an explicit canonical mapping plus its
 * basis, and rejects any new definition that disagrees with the catalog.
 */
return new class extends Migration
{
    public function up(): void
    {
        Schema::table('metric_definitions', function (Blueprint $table): void {
            // `source_owner` remains the historical claim captured when the
            // definition was first created. These fields record the current
            // canonical registry decision without falsifying that claim.
            $table->string('canonical_source_owner')->nullable();
            $table->string('lineage_status')->nullable();
            $table->string('lineage_basis')->nullable();
            $table->timestampTz('lineage_recorded_at')->nullable();
        });

        // CRM, Placement, and Enrollment have canonical reporting facts. The
        // old values remain accepted only so existing historical claims can
        // survive intact; the trigger below prohibits their use for new rows
        // when they disagree with the canonical metric registry.
        DB::statement('ALTER TABLE metric_definitions DROP CONSTRAINT IF EXISTS metric_definitions_source_owner_check');
        DB::statement("ALTER TABLE metric_definitions ADD CONSTRAINT metric_definitions_source_owner_check CHECK (source_owner IN ('finance','payroll','academic_delivery','academic','funding','crm','placement','enrollment'))");

        // Do not replace prior source_owner values. Known keys receive a
        // separate canonical mapping; non-catalog historical rows remain
        // explicitly unresolved rather than being guessed into an authority.
        DB::statement(<<<'SQL'
            UPDATE metric_definitions
               SET canonical_source_owner = CASE key
                       WHEN 'student_outstanding_balance' THEN 'finance'
                       WHEN 'payroll_total' THEN 'finance'
                       WHEN 'active_enrollment_count' THEN 'enrollment'
                       WHEN 'attendance_rate' THEN 'academic'
                       WHEN 'fund_utilization' THEN 'finance'
                       WHEN 'visitor_capture_count' THEN 'crm'
                       WHEN 'visitor_conversion_count' THEN 'crm'
                       WHEN 'visitor_conversion_rate' THEN 'crm'
                       WHEN 'placement_profile_count' THEN 'placement'
                       WHEN 'placement_release_count' THEN 'placement'
                       WHEN 'placement_recommendation_rate' THEN 'placement'
                   END,
                   lineage_status = CASE
                       WHEN source_owner = CASE key
                           WHEN 'student_outstanding_balance' THEN 'finance'
                           WHEN 'payroll_total' THEN 'finance'
                           WHEN 'active_enrollment_count' THEN 'enrollment'
                           WHEN 'attendance_rate' THEN 'academic'
                           WHEN 'fund_utilization' THEN 'finance'
                           WHEN 'visitor_capture_count' THEN 'crm'
                           WHEN 'visitor_conversion_count' THEN 'crm'
                           WHEN 'visitor_conversion_rate' THEN 'crm'
                           WHEN 'placement_profile_count' THEN 'placement'
                           WHEN 'placement_release_count' THEN 'placement'
                           WHEN 'placement_recommendation_rate' THEN 'placement'
                       END THEN 'aligned'
                       ELSE 'canonicalized_claim_preserved'
                   END,
                   lineage_basis = 'catalog_2026_09_07',
                   lineage_recorded_at = CURRENT_TIMESTAMP
             WHERE key IN (
                 'student_outstanding_balance',
                 'payroll_total',
                 'active_enrollment_count',
                 'attendance_rate',
                 'fund_utilization',
                 'visitor_capture_count',
                 'visitor_conversion_count',
                 'visitor_conversion_rate',
                 'placement_profile_count',
                 'placement_release_count',
                 'placement_recommendation_rate'
             );
            SQL);
        DB::statement(<<<'SQL'
            UPDATE metric_definitions
               SET canonical_source_owner = NULL,
                   lineage_status = 'legacy_unresolved',
                   lineage_basis = 'catalog_2026_09_07_unknown_historical_key',
                   lineage_recorded_at = CURRENT_TIMESTAMP
             WHERE lineage_status IS NULL;
            SQL);
        DB::statement(<<<'SQL'
            ALTER TABLE metric_definitions
                ADD CONSTRAINT metric_definitions_lineage_shape_check
                CHECK (
                    (lineage_status = 'aligned'
                        AND canonical_source_owner IS NOT NULL
                        AND source_owner = canonical_source_owner)
                    OR (lineage_status = 'canonicalized_claim_preserved'
                        AND canonical_source_owner IS NOT NULL
                        AND source_owner IS DISTINCT FROM canonical_source_owner)
                    OR (lineage_status = 'legacy_unresolved'
                        AND canonical_source_owner IS NULL)
                ) NOT VALID
            SQL);

        DB::statement(<<<'SQL'
            CREATE OR REPLACE FUNCTION metric_definitions_lineage_guard() RETURNS trigger AS $fn$
            DECLARE
                expected_owner text;
                expected_period_authority text;
            BEGIN
                IF TG_OP = 'UPDATE' THEN
                    // Definition identity and lineage are historical evidence.
                    // A revision appends a metric_version and advances only the
                    // version pointer; it never rewrites its original claim.
                    IF OLD.key IS DISTINCT FROM NEW.key
                       OR OLD.name IS DISTINCT FROM NEW.name
                       OR OLD.source_owner IS DISTINCT FROM NEW.source_owner
                       OR OLD.canonical_source_owner IS DISTINCT FROM NEW.canonical_source_owner
                       OR OLD.period_authority IS DISTINCT FROM NEW.period_authority
                       OR OLD.defined_by IS DISTINCT FROM NEW.defined_by
                       OR OLD.lineage_status IS DISTINCT FROM NEW.lineage_status
                       OR OLD.lineage_basis IS DISTINCT FROM NEW.lineage_basis
                       OR OLD.lineage_recorded_at IS DISTINCT FROM NEW.lineage_recorded_at
                       OR OLD.created_at IS DISTINCT FROM NEW.created_at THEN
                        RAISE EXCEPTION 'metric definition identity and lineage are immutable; append a metric version instead'
                            USING ERRCODE = 'check_violation';
                    END IF;
                    IF NEW.current_version IS DISTINCT FROM OLD.current_version THEN
                        IF NEW.current_version <> OLD.current_version + 1
                           OR NOT EXISTS (
                               SELECT 1 FROM metric_versions mv
                                WHERE mv.metric_id = OLD.id
                                  AND mv.version_no = NEW.current_version
                           ) THEN
                            RAISE EXCEPTION 'metric definition current version must advance exactly to an existing appended version'
                                USING ERRCODE = 'check_violation';
                        END IF;
                    END IF;
                    RETURN NEW;
                END IF;

                expected_owner := CASE NEW.key
                    WHEN 'student_outstanding_balance' THEN 'finance'
                    WHEN 'payroll_total' THEN 'finance'
                    WHEN 'active_enrollment_count' THEN 'enrollment'
                    WHEN 'attendance_rate' THEN 'academic'
                    WHEN 'fund_utilization' THEN 'finance'
                    WHEN 'visitor_capture_count' THEN 'crm'
                    WHEN 'visitor_conversion_count' THEN 'crm'
                    WHEN 'visitor_conversion_rate' THEN 'crm'
                    WHEN 'placement_profile_count' THEN 'placement'
                    WHEN 'placement_release_count' THEN 'placement'
                    WHEN 'placement_recommendation_rate' THEN 'placement'
                    ELSE NULL
                END;
                expected_period_authority := CASE NEW.key
                    WHEN 'student_outstanding_balance' THEN 'financial_period'
                    WHEN 'payroll_total' THEN 'payroll_period'
                    WHEN 'active_enrollment_count' THEN 'academic_period'
                    WHEN 'attendance_rate' THEN 'academic_period'
                    WHEN 'fund_utilization' THEN 'financial_period'
                    WHEN 'visitor_capture_count' THEN 'academic_period'
                    WHEN 'visitor_conversion_count' THEN 'academic_period'
                    WHEN 'visitor_conversion_rate' THEN 'academic_period'
                    WHEN 'placement_profile_count' THEN 'academic_period'
                    WHEN 'placement_release_count' THEN 'academic_period'
                    WHEN 'placement_recommendation_rate' THEN 'academic_period'
                    ELSE NULL
                END;

                IF expected_owner IS NULL THEN
                    RAISE EXCEPTION 'metric definitions must use a canonical catalog key'
                        USING ERRCODE = 'check_violation';
                END IF;
                IF NEW.source_owner IS DISTINCT FROM expected_owner
                   OR NEW.canonical_source_owner IS DISTINCT FROM expected_owner
                   OR NEW.period_authority IS DISTINCT FROM expected_period_authority
                   OR NEW.lineage_status IS DISTINCT FROM 'aligned'
                   OR NEW.lineage_basis IS DISTINCT FROM 'catalog_2026_09_07'
                   OR NEW.lineage_recorded_at IS NULL
                   OR NEW.current_version <> 1 THEN
                    RAISE EXCEPTION 'new metric definition lineage must match its canonical owner and period authority'
                        USING ERRCODE = 'check_violation';
                END IF;

                RETURN NEW;
            END;
            $fn$ LANGUAGE plpgsql;
            SQL);
        DB::statement('DROP TRIGGER IF EXISTS metric_definitions_lineage_guard_trigger ON metric_definitions');
        DB::statement('CREATE TRIGGER metric_definitions_lineage_guard_trigger BEFORE INSERT OR UPDATE ON metric_definitions FOR EACH ROW EXECUTE FUNCTION metric_definitions_lineage_guard()');
    }

    public function down(): void
    {
        // The fields distinguish preserved historical claims from the live
        // canonical registry. Dropping them would erase that audit boundary,
        // so this convergence migration is intentionally forward-only.
        throw new \RuntimeException('Metric-definition lineage convergence is one-way; do not erase preserved owner claims.');
    }
};
