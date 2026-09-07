<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Schema;

/**
 * A PlacementRecommendation is append-only evidence, but the profile pointer
 * and human review/approval/release provenance were previously protected only
 * for same-state updates. A raw update could therefore change them while
 * taking an otherwise legal later lifecycle transition. This migration makes
 * the profile's projection of that immutable recommendation legal exactly
 * once, and distinguishes new guarded decision facts from pre-convergence
 * v2 rows whose old transition history cannot be proven retroactively.
 */
return new class extends Migration
{
    private const DECISION_FACT_VERSION = 'placement-decision-facts-v3';

    public function up(): void
    {
        Schema::table('placement_profiles', function (Blueprint $table): void {
            // The database writes this marker when a new v3 profile is opened
            // or when a pre-v3 scored profile first makes its guarded
            // recommendation transition. Existing recommendation history is
            // deliberately not backfilled or relabeled.
            $table->string('decision_fact_version')->nullable();
        });

        DB::statement(<<<'SQL'
            ALTER TABLE placement_profiles
                ADD CONSTRAINT placement_profiles_decision_fact_version_check
                CHECK (
                    decision_fact_version IS NULL
                    OR decision_fact_version = 'placement-decision-facts-v3'
                ) NOT VALID
            SQL);

        DB::statement(<<<'SQL'
            CREATE OR REPLACE FUNCTION placement_profile_decision_facts_guard() RETURNS trigger AS $fn$
            BEGIN
                IF TG_OP = 'INSERT' THEN
                    IF NEW.lineage_version IS DISTINCT FROM 'placement-evidence-v2' THEN
                        IF NEW.decision_fact_version IS NOT NULL THEN
                            RAISE EXCEPTION 'only a v2 placement profile can carry guarded decision-fact provenance'
                                USING ERRCODE = 'check_violation';
                        END IF;
                        RETURN NEW;
                    END IF;

                    IF NEW.reviewed_by IS NOT NULL
                       OR NEW.approved_by IS NOT NULL
                       OR NEW.released_by IS NOT NULL THEN
                        RAISE EXCEPTION 'a new placement profile cannot precompose reviewer, approver, or releaser provenance'
                            USING ERRCODE = 'check_violation';
                    END IF;
                    IF NEW.decision_fact_version IS NOT NULL THEN
                        RAISE EXCEPTION 'placement decision-fact provenance is assigned only by the database guard'
                            USING ERRCODE = 'check_violation';
                    END IF;
                    NEW.decision_fact_version := 'placement-decision-facts-v3';
                    RETURN NEW;
                END IF;

                -- Pre-lineage records remain historical evidence. Do not
                -- reinterpret or rewrite them in a convergence migration.
                IF OLD.lineage_version IS DISTINCT FROM 'placement-evidence-v2' THEN
                    IF OLD.decision_fact_version IS DISTINCT FROM NEW.decision_fact_version THEN
                        RAISE EXCEPTION 'legacy placement decision provenance cannot be reconstructed in place'
                            USING ERRCODE = 'check_violation';
                    END IF;
                    RETURN NEW;
                END IF;

                -- A target program chosen at profile opening is immutable. A
                -- generic test may supply it once when scored -> recommended;
                -- no later lifecycle action may change the academic target.
                IF OLD.program_version_id IS DISTINCT FROM NEW.program_version_id
                   AND NOT (
                       OLD.lifecycle_state = 'scored'
                       AND NEW.lifecycle_state = 'recommended'
                       AND OLD.program_version_id IS NULL
                       AND NEW.program_version_id IS NOT NULL
                   ) THEN
                    RAISE EXCEPTION 'placement target program is immutable outside the initial recommendation transition'
                        USING ERRCODE = 'check_violation';
                END IF;

                -- The profile can project the append-only recommendation only
                -- while it becomes recommended. Thereafter its pointer,
                -- level, class/offering-null shape, and CEFR result are
                -- immutable facts, including through supersession/retirement.
                IF OLD.placement_recommendation_id IS DISTINCT FROM NEW.placement_recommendation_id
                   OR OLD.recommended_level_id IS DISTINCT FROM NEW.recommended_level_id
                   OR OLD.recommended_class_id IS DISTINCT FROM NEW.recommended_class_id
                   OR OLD.recommended_offering_id IS DISTINCT FROM NEW.recommended_offering_id
                   OR OLD.overall_cefr_ref IS DISTINCT FROM NEW.overall_cefr_ref THEN
                    IF OLD.lifecycle_state IS DISTINCT FROM 'scored'
                       OR NEW.lifecycle_state IS DISTINCT FROM 'recommended'
                       OR OLD.placement_recommendation_id IS NOT NULL
                       OR OLD.recommended_level_id IS NOT NULL
                       OR OLD.recommended_class_id IS NOT NULL
                       OR OLD.recommended_offering_id IS NOT NULL
                       OR OLD.overall_cefr_ref IS NOT NULL THEN
                        RAISE EXCEPTION 'placement recommendation facts may be projected only once on the scored-to-recommended transition'
                            USING ERRCODE = 'check_violation';
                    END IF;
                END IF;

                IF OLD.reviewed_by IS DISTINCT FROM NEW.reviewed_by
                   AND (
                       OLD.lifecycle_state IS DISTINCT FROM 'recommended'
                       OR NEW.lifecycle_state IS DISTINCT FROM 'reviewed'
                       OR OLD.reviewed_by IS NOT NULL
                       OR NEW.reviewed_by IS NULL
                   ) THEN
                    RAISE EXCEPTION 'placement reviewer provenance may be assigned only once on the recommended-to-reviewed transition'
                        USING ERRCODE = 'check_violation';
                END IF;
                IF OLD.approved_by IS DISTINCT FROM NEW.approved_by
                   AND (
                       OLD.lifecycle_state IS DISTINCT FROM 'reviewed'
                       OR NEW.lifecycle_state IS DISTINCT FROM 'approved'
                       OR OLD.approved_by IS NOT NULL
                       OR NEW.approved_by IS NULL
                   ) THEN
                    RAISE EXCEPTION 'placement approver provenance may be assigned only once on the reviewed-to-approved transition'
                        USING ERRCODE = 'check_violation';
                END IF;
                IF OLD.released_by IS DISTINCT FROM NEW.released_by
                   AND (
                       OLD.lifecycle_state IS DISTINCT FROM 'approved'
                       OR NEW.lifecycle_state IS DISTINCT FROM 'released'
                       OR OLD.released_by IS NOT NULL
                       OR NEW.released_by IS NULL
                   ) THEN
                    RAISE EXCEPTION 'placement releaser provenance may be assigned only once on the approved-to-released transition'
                        USING ERRCODE = 'check_violation';
                END IF;

                IF OLD.decision_fact_version IS NOT NULL THEN
                    IF OLD.decision_fact_version IS DISTINCT FROM 'placement-decision-facts-v3'
                       OR OLD.decision_fact_version IS DISTINCT FROM NEW.decision_fact_version THEN
                        RAISE EXCEPTION 'placement decision-fact provenance is immutable historical evidence'
                            USING ERRCODE = 'check_violation';
                    END IF;
                    RETURN NEW;
                END IF;

                -- A pre-v3 v2 draft/scored row can become authoritative only
                -- by taking the exact database-guarded recommendation path.
                -- A caller cannot stamp an old released/retired history as if
                -- it had always been protected by this invariant.
                IF OLD.decision_fact_version IS DISTINCT FROM NEW.decision_fact_version THEN
                    IF NEW.decision_fact_version IS NOT NULL THEN
                        RAISE EXCEPTION 'placement decision-fact provenance is assigned only by the database guard'
                            USING ERRCODE = 'check_violation';
                    END IF;
                    RAISE EXCEPTION 'placement decision-fact provenance cannot be removed'
                        USING ERRCODE = 'check_violation';
                END IF;
                IF OLD.lifecycle_state = 'scored' AND NEW.lifecycle_state = 'recommended' THEN
                    NEW.decision_fact_version := 'placement-decision-facts-v3';
                END IF;

                RETURN NEW;
            END;
            $fn$ LANGUAGE plpgsql;
            SQL);
        DB::statement('DROP TRIGGER IF EXISTS placement_profile_decision_facts_guard_trigger ON placement_profiles');
        DB::statement('CREATE TRIGGER placement_profile_decision_facts_guard_trigger BEFORE INSERT OR UPDATE ON placement_profiles FOR EACH ROW EXECUTE FUNCTION placement_profile_decision_facts_guard()');
    }

    public function down(): void
    {
        // The marker distinguishes evidence written under a stricter immutable
        // lifecycle boundary. Removing it would make historic projections
        // appear to have a weaker provenance, so remediation is forward-only.
        throw new \RuntimeException('Placement decision-fact immutability is one-way; do not erase authoritative provenance.');
    }
};
