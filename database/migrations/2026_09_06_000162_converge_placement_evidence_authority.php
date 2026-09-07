<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Schema;

/**
 * Placement evidence convergence.
 *
 * Earlier Placement tables established useful foreign keys and append-only
 * intentions, but they did not bind a recommendation to an exact attempt,
 * allowed branchless new delivery facts, and left several direct-SQL evidence
 * compositions/lifecycle paths open. This migration preserves legacy rows as
 * historical unknowns while requiring every newly written decision chain to
 * carry explicit v2 lineage and to satisfy the database boundary guards.
 */
return new class extends Migration
{
    private const LINEAGE_VERSION = 'placement-evidence-v2';

    private const SNAPSHOT_VERSION = 'academic-context-snapshot-v2';

    public function up(): void
    {
        Schema::table('placement_profiles', function (Blueprint $table): void {
            $table->char('placement_recommendation_id', 36)->nullable();
            $table->string('lineage_version')->nullable();
            $table->foreign('placement_recommendation_id')->references('id')->on('placement_recommendations');
        });
        Schema::table('placement_attempts', function (Blueprint $table): void {
            $table->string('lineage_version')->nullable();
        });
        Schema::table('placement_recommendations', function (Blueprint $table): void {
            $table->char('attempt_id', 36)->nullable();
            $table->char('program_version_id', 36)->nullable();
            $table->string('lineage_version')->nullable();
            $table->foreign('attempt_id')->references('id')->on('placement_attempts');
            $table->foreign('program_version_id')->references('id')->on('program_versions');
        });
        Schema::table('placement_section_results', function (Blueprint $table): void {
            $table->string('scoring_method')->nullable();
        });
        // Automatic scoring is server attribution, not a fabricated Person.
        DB::statement('ALTER TABLE placement_section_results ALTER COLUMN scored_by DROP NOT NULL');

        DB::statement("ALTER TABLE placement_section_results ADD CONSTRAINT placement_section_results_scoring_method_check CHECK (scoring_method IS NULL OR scoring_method IN ('automatic', 'professional'))");
        DB::statement('ALTER TABLE placement_rubrics ADD CONSTRAINT placement_rubrics_v2_range_check CHECK (min_score >= 0 AND max_score <= 100)');

        // Catalog components are the scoring contract. Existing duplicate
        // components/orders cannot safely be silently selected or rewritten.
        DB::statement(<<<'SQL'
            DO $block$
            BEGIN
                IF EXISTS (
                    SELECT 1 FROM placement_sections
                     GROUP BY test_version_id, component HAVING count(*) > 1
                ) THEN
                    RAISE EXCEPTION 'placement remediation required: a version has duplicate component sections';
                END IF;
                IF EXISTS (
                    SELECT 1 FROM placement_sections
                     GROUP BY test_version_id, section_order HAVING count(*) > 1
                ) THEN
                    RAISE EXCEPTION 'placement remediation required: a version has duplicate section ordering';
                END IF;
            END;
            $block$;
        SQL);
        DB::statement('CREATE UNIQUE INDEX placement_sections_one_component_per_version ON placement_sections (test_version_id, component)');
        DB::statement('CREATE UNIQUE INDEX placement_sections_one_order_per_version ON placement_sections (test_version_id, section_order)');
        DB::statement("CREATE UNIQUE INDEX placement_attempts_one_v2_decision_attempt_per_profile ON placement_attempts (profile_id) WHERE lineage_version = 'placement-evidence-v2' AND status IN ('scheduled', 'in_progress', 'submitted', 'timed_out')");
        DB::statement("CREATE UNIQUE INDEX placement_recommendations_one_v2_per_profile ON placement_recommendations (profile_id) WHERE lineage_version = 'placement-evidence-v2'");
        DB::statement(<<<'SQL'
            DO $block$
            BEGIN
                IF EXISTS (
                    SELECT 1 FROM academic_eligibility_snapshots
                     WHERE supersedes_snapshot_id IS NOT NULL
                     GROUP BY supersedes_snapshot_id HAVING count(*) > 1
                ) THEN
                    RAISE EXCEPTION 'placement remediation required: an eligibility snapshot has multiple successors';
                END IF;
            END;
            $block$;
        SQL);
        DB::statement('CREATE UNIQUE INDEX academic_eligibility_snapshots_one_successor ON academic_eligibility_snapshots (supersedes_snapshot_id) WHERE supersedes_snapshot_id IS NOT NULL');
        DB::statement("CREATE UNIQUE INDEX academic_eligibility_snapshots_one_v2_per_profile ON academic_eligibility_snapshots (placement_profile_id) WHERE snapshot_schema_version = 'academic-context-snapshot-v2'");

        DB::statement(<<<'SQL'
            CREATE OR REPLACE FUNCTION placement_v2_assert_active_branch(p_branch_id char(36), p_context text) RETURNS void AS $fn$
            BEGIN
                IF p_branch_id IS NULL OR trim(p_branch_id) = '' OR NOT EXISTS (
                    SELECT 1
                      FROM branches b
                      JOIN campus_assignments ca
                        ON ca.branch_id = b.id
                       AND ca.effective_from <= CURRENT_DATE
                       AND (ca.effective_to IS NULL OR ca.effective_to > CURRENT_DATE)
                      JOIN campuses c ON c.id = ca.campus_id
                      JOIN organizations o ON o.id = c.organization_id
                     WHERE b.id = p_branch_id
                       AND b.lifecycle_state = 'active'
                       AND c.lifecycle_state = 'active'
                       AND o.lifecycle_state = 'active'
                ) THEN
                    RAISE EXCEPTION 'placement % requires an active branch with current campus and organization provenance', p_context
                        USING ERRCODE = 'check_violation';
                END IF;
            END;
            $fn$ LANGUAGE plpgsql;
        SQL);

        // Test-level weights are an immutable part of every version's scoring
        // contract. The original key-existence check accepted extra, negative,
        // non-numeric, or non-100-total weights through raw SQL.
        DB::statement(<<<'SQL'
            CREATE OR REPLACE FUNCTION placement_v2_component_weights_valid(p_weights jsonb) RETURNS boolean AS $fn$
            DECLARE
                invalid_weight boolean;
                total_weight numeric;
            BEGIN
                IF jsonb_typeof(p_weights) IS DISTINCT FROM 'object'
                   OR NOT (p_weights ?& ARRAY['grammar', 'reading', 'listening', 'writing', 'speaking'])
                   OR (SELECT count(*) FROM jsonb_object_keys(p_weights)) <> 5 THEN
                    RETURN FALSE;
                END IF;
                SELECT COALESCE(bool_or(
                           key NOT IN ('grammar', 'reading', 'listening', 'writing', 'speaking')
                           OR value !~ '^[0-9]+([.][0-9]+)?$'
                           OR CASE WHEN value ~ '^[0-9]+([.][0-9]+)?$' THEN value::numeric <= 0 ELSE FALSE END
                       ), FALSE),
                       COALESCE(sum(CASE WHEN value ~ '^[0-9]+([.][0-9]+)?$' THEN value::numeric ELSE 0 END), 0)
                  INTO invalid_weight, total_weight
                  FROM jsonb_each_text(p_weights);
                RETURN NOT invalid_weight AND abs(total_weight - 100.00) <= 0.01;
            END;
            $fn$ LANGUAGE plpgsql IMMUTABLE;
        SQL);
        DB::statement(<<<'SQL'
            DO $block$
            BEGIN
                IF EXISTS (SELECT 1 FROM placement_tests WHERE NOT placement_v2_component_weights_valid(component_weights)) THEN
                    RAISE EXCEPTION 'placement remediation required: a test has invalid component weights';
                END IF;
            END;
            $block$;
        SQL);
        DB::statement('ALTER TABLE placement_tests ADD CONSTRAINT placement_tests_v2_component_weights_check CHECK (placement_v2_component_weights_valid(component_weights))');

        // Structural evidence completeness is independently enforced at the
        // decision boundary. Cryptographic HMAC verification remains in the
        // application signer/verifier because its key is intentionally not a
        // database secret.
        DB::statement(<<<'SQL'
            CREATE OR REPLACE FUNCTION placement_v2_assert_complete_result_set(p_attempt_id char(36)) RETURNS void AS $fn$
            DECLARE
                attempt_version char(36);
                attempt_state text;
                attempt_lineage text;
                expected_count integer;
                actual_count integer;
            BEGIN
                SELECT test_version_id, status, lineage_version
                  INTO attempt_version, attempt_state, attempt_lineage
                  FROM placement_attempts WHERE id = p_attempt_id;
                IF attempt_version IS NULL OR attempt_state IS DISTINCT FROM 'submitted' OR attempt_lineage IS DISTINCT FROM 'placement-evidence-v2' THEN
                    RAISE EXCEPTION 'placement decision evidence requires an exact submitted v2 attempt'
                        USING ERRCODE = 'check_violation';
                END IF;
                SELECT count(*) INTO expected_count
                  FROM placement_sections
                 WHERE test_version_id = attempt_version AND lifecycle_state = 'published';
                SELECT count(*) INTO actual_count
                  FROM placement_section_results
                 WHERE attempt_id = p_attempt_id;
                IF expected_count = 0 OR actual_count <> expected_count
                   OR EXISTS (
                       SELECT 1
                         FROM placement_section_results r
                         LEFT JOIN placement_sections s ON s.id = r.section_id
                        WHERE r.attempt_id = p_attempt_id
                          AND (r.raw_score IS NULL
                            OR r.scoring_method IS NULL
                            OR s.id IS NULL
                            OR s.test_version_id IS DISTINCT FROM attempt_version
                            OR s.lifecycle_state IS DISTINCT FROM 'published'
                            OR s.component IS DISTINCT FROM r.component)
                   ) THEN
                    RAISE EXCEPTION 'placement decision evidence requires exactly the complete scored result set for its immutable version'
                        USING ERRCODE = 'check_violation';
                END IF;
            END;
            $fn$ LANGUAGE plpgsql;
        SQL);
        DB::statement(<<<'SQL'
            CREATE OR REPLACE FUNCTION placement_v2_assert_approved_result_set(p_attempt_id char(36)) RETURNS void AS $fn$
            BEGIN
                PERFORM placement_v2_assert_complete_result_set(p_attempt_id);
                IF EXISTS (
                    SELECT 1 FROM placement_section_results
                     WHERE attempt_id = p_attempt_id AND lifecycle_state IS DISTINCT FROM 'approved'
                ) THEN
                    RAISE EXCEPTION 'placement review and release require independently approved exact attempt results'
                        USING ERRCODE = 'check_violation';
                END IF;
            END;
            $fn$ LANGUAGE plpgsql;
        SQL);

        // Recommendation values are a deterministic projection of immutable
        // section facts and the frozen test weights. The database repeats this
        // narrow calculation so a direct SQL insert cannot point a candidate at
        // a more favourable academic level or forge the reporting snapshot.
        DB::statement(<<<'SQL'
            CREATE OR REPLACE FUNCTION placement_v2_cefr_rank(p_cefr text) RETURNS integer AS $fn$
            BEGIN
                RETURN CASE upper(trim(COALESCE(p_cefr, '')))
                    WHEN 'A1' THEN 0
                    WHEN 'A2' THEN 1
                    WHEN 'B1' THEN 2
                    WHEN 'B2' THEN 3
                    WHEN 'C1' THEN 4
                    ELSE -1
                END;
            END;
            $fn$ LANGUAGE plpgsql IMMUTABLE;
        SQL);
        DB::statement(<<<'SQL'
            CREATE OR REPLACE FUNCTION placement_v2_json_number_equals(
                p_object jsonb, p_key text, p_expected numeric
            ) RETURNS boolean AS $fn$
            DECLARE
                value_json jsonb;
                value_text text;
            BEGIN
                value_json := p_object -> p_key;
                IF jsonb_typeof(value_json) IS DISTINCT FROM 'number' THEN
                    RETURN FALSE;
                END IF;
                value_text := p_object ->> p_key;
                IF value_text !~ '^-?[0-9]+([.][0-9]+)?$' THEN
                    RETURN FALSE;
                END IF;
                RETURN value_text::numeric IS NOT DISTINCT FROM p_expected;
            END;
            $fn$ LANGUAGE plpgsql IMMUTABLE;
        SQL);
        DB::statement(<<<'SQL'
            CREATE OR REPLACE FUNCTION placement_v2_assert_recommendation_derivation(
                p_attempt_id char(36),
                p_program_version_id char(36),
                p_recommended_level_id char(36),
                p_model_version text,
                p_score_snapshot jsonb
            ) RETURNS void AS $fn$
            DECLARE
                attempt_version char(36);
                test_weights jsonb;
                component_name text;
                component_score numeric;
                component_cefr text;
                component_weight numeric;
                weighted_total numeric := 0;
                total_weight numeric := 0;
                overall_score numeric;
                overall_cefr text;
                expected_level char(36);
                overall_rank integer;
            BEGIN
                IF p_model_version IS DISTINCT FROM 'placement-rubric-v1'
                   OR jsonb_typeof(p_score_snapshot) IS DISTINCT FROM 'object' THEN
                    RAISE EXCEPTION 'a v2 placement recommendation requires the exact canonical placement-rubric-v1 score snapshot'
                        USING ERRCODE = 'check_violation';
                END IF;
                IF (SELECT count(*) FROM jsonb_object_keys(p_score_snapshot)) <> 5
                   OR NOT (p_score_snapshot ?& ARRAY['overall_percentage', 'overall_cefr', 'component_percentages', 'component_cefr', 'model_version'])
                   OR p_score_snapshot->>'model_version' IS DISTINCT FROM 'placement-rubric-v1'
                   OR jsonb_typeof(p_score_snapshot->'component_percentages') IS DISTINCT FROM 'object'
                   OR jsonb_typeof(p_score_snapshot->'component_cefr') IS DISTINCT FROM 'object' THEN
                    RAISE EXCEPTION 'a v2 placement recommendation requires the exact canonical placement-rubric-v1 score snapshot'
                        USING ERRCODE = 'check_violation';
                END IF;
                IF (SELECT count(*) FROM jsonb_object_keys(p_score_snapshot->'component_percentages')) <> 5
                   OR (SELECT count(*) FROM jsonb_object_keys(p_score_snapshot->'component_cefr')) <> 5
                   OR NOT ((p_score_snapshot->'component_percentages') ?& ARRAY['grammar', 'reading', 'listening', 'writing', 'speaking'])
                   OR NOT ((p_score_snapshot->'component_cefr') ?& ARRAY['grammar', 'reading', 'listening', 'writing', 'speaking']) THEN
                    RAISE EXCEPTION 'a v2 placement recommendation requires the exact canonical placement-rubric-v1 score snapshot'
                        USING ERRCODE = 'check_violation';
                END IF;

                SELECT a.test_version_id, t.component_weights
                  INTO attempt_version, test_weights
                  FROM placement_attempts a
                  JOIN placement_test_versions v ON v.id = a.test_version_id
                  JOIN placement_tests t ON t.id = v.placement_test_id
                 WHERE a.id = p_attempt_id;
                IF attempt_version IS NULL OR NOT placement_v2_component_weights_valid(test_weights) THEN
                    RAISE EXCEPTION 'a v2 placement recommendation requires a valid frozen test scoring contract'
                        USING ERRCODE = 'check_violation';
                END IF;

                FOREACH component_name IN ARRAY ARRAY['grammar', 'reading', 'listening', 'writing', 'speaking'] LOOP
                    SELECT COALESCE(r.weighted_score, r.raw_score)
                      INTO component_score
                      FROM placement_section_results r
                      JOIN placement_sections s ON s.id = r.section_id
                     WHERE r.attempt_id = p_attempt_id
                       AND s.component = component_name;
                    IF component_score IS NULL THEN
                        RAISE EXCEPTION 'a v2 placement recommendation requires one completed result for every component'
                            USING ERRCODE = 'check_violation';
                    END IF;
                    SELECT cefr_ref INTO component_cefr
                      FROM placement_rubrics
                     WHERE test_version_id = attempt_version
                       AND component = component_name
                       AND lifecycle_state = 'published'
                       AND component_score >= min_score
                       AND component_score <= max_score;
                    IF component_cefr IS NULL
                       OR p_score_snapshot->'component_cefr'->>component_name IS DISTINCT FROM component_cefr
                       OR NOT placement_v2_json_number_equals(p_score_snapshot->'component_percentages', component_name, round(component_score, 2)) THEN
                        RAISE EXCEPTION 'a v2 placement recommendation component snapshot must be derived from its exact published result and rubric'
                            USING ERRCODE = 'check_violation';
                    END IF;
                    component_weight := (test_weights ->> component_name)::numeric;
                    weighted_total := weighted_total + (component_score * component_weight);
                    total_weight := total_weight + component_weight;
                END LOOP;
                IF total_weight <= 0 THEN
                    RAISE EXCEPTION 'a v2 placement recommendation requires positive frozen component weights'
                        USING ERRCODE = 'check_violation';
                END IF;
                -- Recommendations persist a two-decimal percentage. Classify
                -- that canonical NUMERIC value so a midpoint such as 39.995
                -- cannot fall through the 39.99/40.00 band boundary.
                overall_score := round(weighted_total / total_weight, 2);
                overall_cefr := CASE
                    WHEN overall_score >= 0 AND overall_score <= 39.99 THEN 'A1'
                    WHEN overall_score >= 40 AND overall_score <= 54.99 THEN 'A2'
                    WHEN overall_score >= 55 AND overall_score <= 69.99 THEN 'B1'
                    WHEN overall_score >= 70 AND overall_score <= 84.99 THEN 'B2'
                    WHEN overall_score >= 85 AND overall_score <= 100 THEN 'C1'
                    ELSE NULL
                END;
                IF overall_cefr IS NULL
                   OR p_score_snapshot->>'overall_cefr' IS DISTINCT FROM overall_cefr
                   OR NOT placement_v2_json_number_equals(p_score_snapshot, 'overall_percentage', round(overall_score, 2)) THEN
                    RAISE EXCEPTION 'a v2 placement recommendation overall score and CEFR must be exactly derived from frozen component facts'
                        USING ERRCODE = 'check_violation';
                END IF;

                SELECT id INTO expected_level
                  FROM program_version_levels
                 WHERE program_version_id = p_program_version_id
                   AND lifecycle_state = 'active'
                   AND upper(COALESCE(cefr_ref, '')) = overall_cefr
                 ORDER BY ordinal
                 LIMIT 1;
                overall_rank := placement_v2_cefr_rank(overall_cefr);
                IF expected_level IS NULL THEN
                    SELECT id INTO expected_level
                      FROM program_version_levels
                     WHERE program_version_id = p_program_version_id
                       AND lifecycle_state = 'active'
                       AND placement_v2_cefr_rank(cefr_ref) BETWEEN 0 AND overall_rank
                     ORDER BY ordinal DESC
                     LIMIT 1;
                END IF;
                IF expected_level IS NULL THEN
                    SELECT id INTO expected_level
                      FROM program_version_levels
                     WHERE program_version_id = p_program_version_id
                       AND lifecycle_state = 'active'
                       AND placement_v2_cefr_rank(cefr_ref) >= 0
                     ORDER BY ordinal
                     LIMIT 1;
                END IF;
                IF expected_level IS NULL OR expected_level IS DISTINCT FROM p_recommended_level_id THEN
                    RAISE EXCEPTION 'a v2 placement recommendation must select the deterministic active academic level for its derived CEFR'
                        USING ERRCODE = 'check_violation';
                END IF;
            END;
            $fn$ LANGUAGE plpgsql;
        SQL);

        // Do not let an unknown legacy provenance be "repaired" by an
        // ordinary UPDATE. New profiles are always concrete branch facts.
        DB::statement(<<<'SQL'
            CREATE OR REPLACE FUNCTION placement_v2_assert_auto_score_from_responses(
                p_attempt_id char(36), p_section_id char(36), p_raw_score numeric, p_weighted_score numeric
            ) RETURNS void AS $fn$
            DECLARE
                question_count integer;
                response_count integer;
                earned_score numeric;
                maximum_score numeric;
            BEGIN
                SELECT count(q.id), count(r.id),
                       COALESCE(sum(CASE WHEN lower(trim(r.response_value)) = lower(trim(q.correct_answer)) THEN q.points ELSE 0 END), 0),
                       COALESCE(sum(q.points), 0)
                  INTO question_count, response_count, earned_score, maximum_score
                  FROM placement_questions q
                  LEFT JOIN placement_responses r
                    ON r.attempt_id = p_attempt_id AND r.question_id = q.id
                 WHERE q.section_id = p_section_id AND q.lifecycle_state = 'published';
                IF question_count = 0 OR response_count <> question_count OR maximum_score <= 0
                   OR p_raw_score IS DISTINCT FROM round(earned_score, 2)
                   OR p_weighted_score IS DISTINCT FROM round(earned_score / maximum_score * 100, 2) THEN
                    RAISE EXCEPTION 'automatic placement section results must be exactly derived from every immutable normalized response'
                        USING ERRCODE = 'check_violation';
                END IF;
            END;
            $fn$ LANGUAGE plpgsql;
        SQL);

        DB::statement(<<<'SQL'
            CREATE OR REPLACE FUNCTION placement_v2_assert_submittable_response_set(
                p_attempt_id char(36), p_version_id char(36), p_delivery_mode text
            ) RETURNS void AS $fn$
            DECLARE
                question_count integer;
                published_question_count integer;
                response_count integer;
                auto_section_exists boolean;
            BEGIN
                SELECT count(*), count(*) FILTER (WHERE q.lifecycle_state = 'published')
                  INTO question_count, published_question_count
                  FROM placement_questions q
                  JOIN placement_sections s ON s.id = q.section_id
                 WHERE s.test_version_id = p_version_id;
                SELECT count(*) INTO response_count
                  FROM placement_responses WHERE attempt_id = p_attempt_id;
                SELECT EXISTS (
                    SELECT 1 FROM placement_sections
                     WHERE test_version_id = p_version_id AND lifecycle_state = 'published' AND can_auto_score
                ) INTO auto_section_exists;
                IF question_count = 0 OR question_count <> published_question_count
                   OR (p_delivery_mode = 'digital' AND response_count <> published_question_count)
                   OR (p_delivery_mode = 'physical' AND auto_section_exists AND response_count <> published_question_count)
                   OR (p_delivery_mode = 'physical' AND NOT auto_section_exists AND response_count NOT IN (0, published_question_count)) THEN
                    RAISE EXCEPTION 'submitted placement evidence requires the exact published response set for digital or auto-scored physical delivery'
                        USING ERRCODE = 'check_violation';
                END IF;
            END;
            $fn$ LANGUAGE plpgsql;
        SQL);

        DB::statement(<<<'SQL'
            CREATE OR REPLACE FUNCTION placement_v2_profile_anchor_guard() RETURNS trigger AS $fn$
            BEGIN
                IF TG_OP = 'INSERT' THEN
                    IF NEW.lineage_version IS DISTINCT FROM 'placement-evidence-v2'
                       OR NEW.lifecycle_state IS DISTINCT FROM 'draft'
                       OR NEW.placement_recommendation_id IS NOT NULL
                       OR NEW.recommended_level_id IS NOT NULL
                       OR NEW.recommended_class_id IS NOT NULL
                       OR NEW.recommended_offering_id IS NOT NULL
                       OR NEW.overall_cefr_ref IS NOT NULL
                       OR NEW.academic_eligibility_snapshot_id IS NOT NULL THEN
                        RAISE EXCEPTION 'new placement profiles require a draft placement-evidence-v2 lifecycle with no precomposed decision facts'
                            USING ERRCODE = 'check_violation';
                    END IF;
                    IF NEW.originating_branch_id IS DISTINCT FROM NEW.current_home_branch_id THEN
                        RAISE EXCEPTION 'new placement profiles require matching originating and current-home branch provenance'
                            USING ERRCODE = 'check_violation';
                    END IF;
                    PERFORM placement_v2_assert_active_branch(NEW.originating_branch_id, 'profile');
                ELSE
                    IF OLD.lineage_version IS DISTINCT FROM NEW.lineage_version THEN
                        RAISE EXCEPTION 'placement profile lineage version is immutable'
                            USING ERRCODE = 'check_violation';
                    END IF;
                    IF OLD.originating_branch_id IS DISTINCT FROM NEW.originating_branch_id
                       OR OLD.current_home_branch_id IS DISTINCT FROM NEW.current_home_branch_id THEN
                        RAISE EXCEPTION 'placement profile branch provenance is immutable; unknown history is not backfilled'
                            USING ERRCODE = 'check_violation';
                    END IF;
                END IF;
                RETURN NEW;
            END;
            $fn$ LANGUAGE plpgsql;
        SQL);
        DB::statement('CREATE TRIGGER placement_v2_profile_anchor_guard_trigger BEFORE INSERT OR UPDATE ON placement_profiles FOR EACH ROW EXECUTE FUNCTION placement_v2_profile_anchor_guard()');

        DB::statement(<<<'SQL'
            CREATE OR REPLACE FUNCTION placement_v2_test_anchor_guard() RETURNS trigger AS $fn$
            BEGIN
                IF TG_OP = 'INSERT' THEN
                    IF NEW.lifecycle_state IS DISTINCT FROM 'draft' THEN
                        RAISE EXCEPTION 'new placement tests must begin as drafts'
                            USING ERRCODE = 'check_violation';
                    END IF;
                    IF NEW.originating_branch_id IS DISTINCT FROM NEW.current_home_branch_id THEN
                        RAISE EXCEPTION 'new placement tests require matching originating and current-home branch provenance'
                            USING ERRCODE = 'check_violation';
                    END IF;
                    PERFORM placement_v2_assert_active_branch(NEW.originating_branch_id, 'test');
                ELSIF OLD.originating_branch_id IS DISTINCT FROM NEW.originating_branch_id
                   OR OLD.current_home_branch_id IS DISTINCT FROM NEW.current_home_branch_id THEN
                    RAISE EXCEPTION 'placement test branch provenance is immutable'
                        USING ERRCODE = 'check_violation';
                END IF;
                RETURN NEW;
            END;
            $fn$ LANGUAGE plpgsql;
        SQL);
        DB::statement('CREATE TRIGGER placement_v2_test_anchor_guard_trigger BEFORE INSERT OR UPDATE ON placement_tests FOR EACH ROW EXECUTE FUNCTION placement_v2_test_anchor_guard()');
        DB::statement(<<<'SQL'
            CREATE OR REPLACE FUNCTION placement_v2_test_lifecycle_guard() RETURNS trigger AS $fn$
            BEGIN
                IF TG_OP = 'DELETE' THEN
                    RAISE EXCEPTION 'placement tests are auditable catalog authority and cannot be deleted'
                        USING ERRCODE = 'check_violation';
                END IF;
                IF OLD.lifecycle_state = NEW.lifecycle_state THEN
                    IF OLD.lifecycle_state IN ('published', 'retired') AND (
                        OLD.key IS DISTINCT FROM NEW.key
                        OR OLD.name IS DISTINCT FROM NEW.name
                        OR OLD.program_version_id IS DISTINCT FROM NEW.program_version_id
                        OR OLD.total_time_minutes IS DISTINCT FROM NEW.total_time_minutes
                        OR OLD.scoring_version IS DISTINCT FROM NEW.scoring_version
                        OR OLD.component_weights IS DISTINCT FROM NEW.component_weights
                        OR OLD.created_at IS DISTINCT FROM NEW.created_at
                    ) THEN
                        RAISE EXCEPTION 'published or retired placement test scoring authority is immutable; publish a corrected version instead'
                            USING ERRCODE = 'check_violation';
                    END IF;
                    RETURN NEW;
                END IF;
                IF (OLD.lifecycle_state = 'draft' AND NEW.lifecycle_state = 'published')
                   OR (OLD.lifecycle_state = 'published' AND NEW.lifecycle_state = 'retired') THEN
                    RETURN NEW;
                END IF;
                RAISE EXCEPTION 'placement test lifecycle transition % -> % is not permitted', OLD.lifecycle_state, NEW.lifecycle_state
                    USING ERRCODE = 'check_violation';
            END;
            $fn$ LANGUAGE plpgsql;
        SQL);
        DB::statement('CREATE TRIGGER placement_v2_test_lifecycle_guard_trigger BEFORE UPDATE OR DELETE ON placement_tests FOR EACH ROW EXECUTE FUNCTION placement_v2_test_lifecycle_guard()');
        DB::statement(<<<'SQL'
            CREATE OR REPLACE FUNCTION placement_v2_version_guard() RETURNS trigger AS $fn$
            DECLARE
                parent_test_state text;
            BEGIN
                IF TG_OP = 'DELETE' THEN
                    RAISE EXCEPTION 'placement test versions are auditable catalog authority and cannot be deleted'
                        USING ERRCODE = 'check_violation';
                END IF;
                SELECT lifecycle_state INTO parent_test_state
                  FROM placement_tests WHERE id = NEW.placement_test_id FOR UPDATE;
                IF parent_test_state IS NULL OR parent_test_state = 'retired' THEN
                    RAISE EXCEPTION 'placement version changes require a non-retired parent test'
                        USING ERRCODE = 'check_violation';
                END IF;
                IF TG_OP = 'INSERT' THEN
                    IF NEW.lifecycle_state IS DISTINCT FROM 'draft' OR NEW.published_at IS NOT NULL THEN
                        RAISE EXCEPTION 'new placement versions must begin as unpublished drafts'
                            USING ERRCODE = 'check_violation';
                    END IF;
                    RETURN NEW;
                END IF;
                IF NEW.placement_test_id IS DISTINCT FROM OLD.placement_test_id
                   OR NEW.version_no IS DISTINCT FROM OLD.version_no THEN
                    RAISE EXCEPTION 'placement version identity is immutable'
                        USING ERRCODE = 'check_violation';
                END IF;
                IF OLD.lifecycle_state = NEW.lifecycle_state THEN
                    IF OLD.lifecycle_state = 'draft' AND NEW.published_at IS NOT NULL THEN
                        RAISE EXCEPTION 'a draft placement version cannot carry a publication time'
                            USING ERRCODE = 'check_violation';
                    END IF;
                    IF OLD.lifecycle_state IN ('published', 'retired')
                       AND (NEW.summary IS DISTINCT FROM OLD.summary
                         OR NEW.published_at IS DISTINCT FROM OLD.published_at
                         OR NEW.created_at IS DISTINCT FROM OLD.created_at) THEN
                        RAISE EXCEPTION 'published or retired placement version content is immutable'
                            USING ERRCODE = 'check_violation';
                    END IF;
                    RETURN NEW;
                END IF;
                IF OLD.lifecycle_state = 'draft' AND NEW.lifecycle_state = 'published' THEN
                    IF NEW.published_at IS NULL OR parent_test_state IS DISTINCT FROM 'published' THEN
                        RAISE EXCEPTION 'a placement version needs a published parent test and publication time'
                            USING ERRCODE = 'check_violation';
                    END IF;
                    RETURN NEW;
                END IF;
                IF (OLD.lifecycle_state = 'draft' OR OLD.lifecycle_state = 'published')
                   AND NEW.lifecycle_state = 'retired' THEN
                    IF (OLD.lifecycle_state = 'draft' AND NEW.published_at IS NOT NULL)
                       OR (OLD.lifecycle_state = 'published' AND NEW.published_at IS DISTINCT FROM OLD.published_at) THEN
                        RAISE EXCEPTION 'a retired placement version may not forge or rewrite its publication time'
                            USING ERRCODE = 'check_violation';
                    END IF;
                    RETURN NEW;
                END IF;
                RAISE EXCEPTION 'placement version lifecycle transition % -> % is not permitted', OLD.lifecycle_state, NEW.lifecycle_state
                    USING ERRCODE = 'check_violation';
            END;
            $fn$ LANGUAGE plpgsql;
        SQL);
        DB::statement('CREATE TRIGGER placement_v2_version_guard_trigger BEFORE INSERT OR UPDATE OR DELETE ON placement_test_versions FOR EACH ROW EXECUTE FUNCTION placement_v2_version_guard()');

        DB::statement(<<<'SQL'
            CREATE OR REPLACE FUNCTION placement_v2_profile_lifecycle_guard() RETURNS trigger AS $fn$
            DECLARE
                recommendation_profile char(36);
                recommendation_attempt char(36);
                recommendation_program char(36);
                recommendation_level char(36);
                recommendation_cefr text;
                decision_attempt char(36);
                snapshot_profile char(36);
                snapshot_person char(36);
                snapshot_recommendation char(36);
                snapshot_schema text;
            BEGIN
                IF OLD.lineage_version IS DISTINCT FROM 'placement-evidence-v2' THEN
                    IF OLD.lifecycle_state IS DISTINCT FROM NEW.lifecycle_state
                       OR OLD.program_version_id IS DISTINCT FROM NEW.program_version_id
                       OR OLD.placement_recommendation_id IS DISTINCT FROM NEW.placement_recommendation_id
                       OR OLD.recommended_level_id IS DISTINCT FROM NEW.recommended_level_id
                       OR OLD.recommended_class_id IS DISTINCT FROM NEW.recommended_class_id
                       OR OLD.recommended_offering_id IS DISTINCT FROM NEW.recommended_offering_id
                       OR OLD.overall_cefr_ref IS DISTINCT FROM NEW.overall_cefr_ref
                       OR OLD.reviewed_by IS DISTINCT FROM NEW.reviewed_by
                       OR OLD.approved_by IS DISTINCT FROM NEW.approved_by
                       OR OLD.released_by IS DISTINCT FROM NEW.released_by
                       OR OLD.academic_eligibility_snapshot_id IS DISTINCT FROM NEW.academic_eligibility_snapshot_id THEN
                        RAISE EXCEPTION 'pre-lineage placement profiles are immutable historical decisions and require governed remediation'
                            USING ERRCODE = 'check_violation';
                    END IF;
                    RETURN NEW;
                END IF;
                IF OLD.person_id IS DISTINCT FROM NEW.person_id
                   OR OLD.visitor_id IS DISTINCT FROM NEW.visitor_id
                   OR OLD.created_by IS DISTINCT FROM NEW.created_by THEN
                    RAISE EXCEPTION 'placement profile identity provenance is immutable'
                        USING ERRCODE = 'check_violation';
                END IF;
                -- Once linked, a release snapshot is permanent evidence even
                -- while the profile later transitions to superseded/retired.
                IF OLD.academic_eligibility_snapshot_id IS NOT NULL
                   AND OLD.academic_eligibility_snapshot_id IS DISTINCT FROM NEW.academic_eligibility_snapshot_id THEN
                    RAISE EXCEPTION 'placement eligibility snapshot pointer is immutable once linked'
                        USING ERRCODE = 'check_violation';
                END IF;
                IF OLD.lifecycle_state = NEW.lifecycle_state THEN
                    IF OLD.academic_eligibility_snapshot_id IS DISTINCT FROM NEW.academic_eligibility_snapshot_id THEN
                        IF OLD.academic_eligibility_snapshot_id IS NOT NULL
                           OR NEW.academic_eligibility_snapshot_id IS NULL
                           OR NEW.lifecycle_state NOT IN ('released', 'superseded') THEN
                            RAISE EXCEPTION 'placement eligibility snapshot pointer may be appended only once to a released profile'
                                USING ERRCODE = 'check_violation';
                        END IF;
                        SELECT placement_profile_id, person_id, placement_recommendation_id, snapshot_schema_version
                          INTO snapshot_profile, snapshot_person, snapshot_recommendation, snapshot_schema
                          FROM academic_eligibility_snapshots WHERE id = NEW.academic_eligibility_snapshot_id;
                        IF snapshot_profile IS NULL
                           OR snapshot_profile IS DISTINCT FROM NEW.id
                           OR snapshot_person IS DISTINCT FROM NEW.person_id
                           OR snapshot_recommendation IS DISTINCT FROM NEW.placement_recommendation_id
                           OR snapshot_schema IS DISTINCT FROM 'academic-context-snapshot-v2' THEN
                            RAISE EXCEPTION 'placement eligibility snapshot pointer must reference this profile exact v2 decision lineage'
                                USING ERRCODE = 'check_violation';
                        END IF;
                        RETURN NEW;
                    END IF;
                    IF OLD IS DISTINCT FROM NEW THEN
                        -- `updated_at` is transport metadata and is the only
                        -- same-state mutation allowed on a v2 profile.
                        IF OLD.program_version_id IS DISTINCT FROM NEW.program_version_id
                           OR OLD.placement_recommendation_id IS DISTINCT FROM NEW.placement_recommendation_id
                           OR OLD.recommended_level_id IS DISTINCT FROM NEW.recommended_level_id
                           OR OLD.recommended_class_id IS DISTINCT FROM NEW.recommended_class_id
                           OR OLD.recommended_offering_id IS DISTINCT FROM NEW.recommended_offering_id
                           OR OLD.overall_cefr_ref IS DISTINCT FROM NEW.overall_cefr_ref
                           OR OLD.reviewed_by IS DISTINCT FROM NEW.reviewed_by
                           OR OLD.approved_by IS DISTINCT FROM NEW.approved_by
                           OR OLD.released_by IS DISTINCT FROM NEW.released_by THEN
                            RAISE EXCEPTION 'placement decision facts are immutable outside their legal lifecycle transition'
                                USING ERRCODE = 'check_violation';
                        END IF;
                    END IF;
                    RETURN NEW;
                END IF;

                IF OLD.lifecycle_state = 'draft' AND NEW.lifecycle_state = 'scored' THEN
                    SELECT id INTO decision_attempt
                      FROM placement_attempts
                     WHERE profile_id = NEW.id
                       AND lineage_version = 'placement-evidence-v2'
                       AND status = 'submitted';
                    IF NOT FOUND OR (SELECT count(*) FROM placement_attempts WHERE profile_id = NEW.id AND lineage_version = 'placement-evidence-v2' AND status = 'submitted') <> 1 THEN
                        RAISE EXCEPTION 'a scored placement profile requires exactly one submitted v2 decision attempt'
                            USING ERRCODE = 'check_violation';
                    END IF;
                    PERFORM placement_v2_assert_complete_result_set(decision_attempt);
                    RETURN NEW;
                END IF;
                IF OLD.lifecycle_state = 'scored' AND NEW.lifecycle_state = 'recommended' THEN
                    IF NEW.placement_recommendation_id IS NULL
                       OR NEW.program_version_id IS NULL
                       OR NEW.recommended_level_id IS NULL
                       OR NEW.recommended_class_id IS NOT NULL
                       OR NEW.recommended_offering_id IS NOT NULL THEN
                        RAISE EXCEPTION 'a v2 recommended profile requires only its exact academic level recommendation'
                            USING ERRCODE = 'check_violation';
                    END IF;
                    SELECT profile_id, attempt_id, program_version_id, recommended_level_id, score_snapshot->>'overall_cefr'
                      INTO recommendation_profile, recommendation_attempt, recommendation_program, recommendation_level, recommendation_cefr
                      FROM placement_recommendations
                     WHERE id = NEW.placement_recommendation_id
                       AND lineage_version = 'placement-evidence-v2';
                    IF recommendation_profile IS NULL
                       OR recommendation_profile IS DISTINCT FROM NEW.id
                       OR recommendation_attempt IS NULL
                       OR recommendation_program IS DISTINCT FROM NEW.program_version_id
                       OR recommendation_level IS DISTINCT FROM NEW.recommended_level_id
                       OR NEW.overall_cefr_ref IS DISTINCT FROM recommendation_cefr THEN
                    RAISE EXCEPTION 'placement profile recommendation pointer must identify matching immutable attempt/program/level/CEFR lineage'
                            USING ERRCODE = 'check_violation';
                    END IF;
                    PERFORM placement_v2_assert_complete_result_set(recommendation_attempt);
                    RETURN NEW;
                END IF;
                IF OLD.lifecycle_state = 'recommended' AND NEW.lifecycle_state = 'reviewed' THEN
                    SELECT attempt_id INTO decision_attempt
                      FROM placement_recommendations
                     WHERE id = NEW.placement_recommendation_id
                       AND profile_id = NEW.id
                       AND lineage_version = 'placement-evidence-v2';
                    IF decision_attempt IS NULL THEN
                        RAISE EXCEPTION 'placement review requires the profile exact recommendation attempt'
                            USING ERRCODE = 'check_violation';
                    END IF;
                    PERFORM placement_v2_assert_approved_result_set(decision_attempt);
                    IF NEW.reviewed_by IS NULL OR NEW.reviewed_by = '' THEN
                        RAISE EXCEPTION 'placement review requires reviewer provenance'
                            USING ERRCODE = 'check_violation';
                    END IF;
                    RETURN NEW;
                END IF;
                IF OLD.lifecycle_state = 'reviewed' AND NEW.lifecycle_state = 'approved' THEN
                    IF NEW.approved_by IS NULL OR NEW.approved_by = '' OR NEW.approved_by = NEW.reviewed_by THEN
                        RAISE EXCEPTION 'placement approval requires an independent approver'
                            USING ERRCODE = 'check_violation';
                    END IF;
                    RETURN NEW;
                END IF;
                IF OLD.lifecycle_state = 'approved' AND NEW.lifecycle_state = 'released' THEN
                    SELECT attempt_id INTO decision_attempt
                      FROM placement_recommendations
                     WHERE id = NEW.placement_recommendation_id
                       AND profile_id = NEW.id
                       AND lineage_version = 'placement-evidence-v2';
                    IF decision_attempt IS NULL THEN
                        RAISE EXCEPTION 'placement release requires the profile exact recommendation attempt'
                            USING ERRCODE = 'check_violation';
                    END IF;
                    PERFORM placement_v2_assert_approved_result_set(decision_attempt);
                    IF NEW.released_by IS NULL OR NEW.released_by = '' THEN
                        RAISE EXCEPTION 'placement release requires releaser provenance'
                            USING ERRCODE = 'check_violation';
                    END IF;
                    RETURN NEW;
                END IF;
                IF OLD.lifecycle_state = 'released' AND NEW.lifecycle_state IN ('superseded', 'retired') THEN
                    RETURN NEW;
                END IF;
                IF OLD.lifecycle_state IN ('draft', 'scored', 'recommended', 'reviewed', 'approved') AND NEW.lifecycle_state = 'retired' THEN
                    RETURN NEW;
                END IF;

                RAISE EXCEPTION 'placement profile lifecycle transition % -> % is not permitted', OLD.lifecycle_state, NEW.lifecycle_state
                    USING ERRCODE = 'check_violation';
            END;
            $fn$ LANGUAGE plpgsql;
        SQL);
        DB::statement('CREATE TRIGGER placement_v2_profile_lifecycle_guard_trigger BEFORE UPDATE ON placement_profiles FOR EACH ROW EXECUTE FUNCTION placement_v2_profile_lifecycle_guard()');

        // Release first, then snapshot-and-link, is intentionally one atomic
        // command transaction. This deferred check observes the final row at
        // commit so it permits that safe ordering but makes a committed v2
        // released/superseded profile without its exact snapshot impossible.
        DB::statement(<<<'SQL'
            CREATE OR REPLACE FUNCTION placement_v2_released_profile_snapshot_guard() RETURNS trigger AS $fn$
            DECLARE
                profile_lineage text;
                profile_state text;
                profile_person char(36);
                profile_recommendation char(36);
                profile_snapshot char(36);
                profile_released_by char(36);
                snapshot_profile char(36);
                snapshot_person char(36);
                snapshot_recommendation char(36);
                snapshot_schema text;
            BEGIN
                -- Read by primary key rather than trusting the deferred
                -- trigger's event image: release and link are separate UPDATEs
                -- in the same transaction, and only the final aggregate state
                -- has authority at commit.
                SELECT lineage_version, lifecycle_state, person_id,
                       placement_recommendation_id, academic_eligibility_snapshot_id,
                       released_by
                  INTO profile_lineage, profile_state, profile_person,
                       profile_recommendation, profile_snapshot, profile_released_by
                  FROM placement_profiles
                 WHERE id = NEW.id;
                IF profile_lineage IS DISTINCT FROM 'placement-evidence-v2' THEN
                    RETURN NULL;
                END IF;
                -- A draft/recommended profile may be retired without ever
                -- releasing. Once release provenance exists, including a
                -- subsequent retired state, the immutable release fact must
                -- remain fully linked.
                IF profile_state NOT IN ('released', 'superseded')
                   AND profile_released_by IS NULL THEN
                    RETURN NULL;
                END IF;
                IF profile_snapshot IS NULL THEN
                    RAISE EXCEPTION 'a released placement profile requires an exact signed v2 eligibility snapshot before commit'
                        USING ERRCODE = 'check_violation';
                END IF;
                SELECT placement_profile_id, person_id, placement_recommendation_id,
                       snapshot_schema_version
                  INTO snapshot_profile, snapshot_person, snapshot_recommendation,
                       snapshot_schema
                  FROM academic_eligibility_snapshots
                 WHERE id = profile_snapshot;
                IF snapshot_profile IS DISTINCT FROM NEW.id
                   OR snapshot_person IS DISTINCT FROM profile_person
                   OR snapshot_recommendation IS DISTINCT FROM profile_recommendation
                   OR snapshot_schema IS DISTINCT FROM 'academic-context-snapshot-v2' THEN
                    RAISE EXCEPTION 'a released placement profile must retain its exact v2 recommendation eligibility snapshot'
                        USING ERRCODE = 'check_violation';
                END IF;
                RETURN NULL;
            END;
            $fn$ LANGUAGE plpgsql;
        SQL);
        DB::statement('CREATE CONSTRAINT TRIGGER placement_v2_released_profile_snapshot_guard_trigger AFTER INSERT OR UPDATE ON placement_profiles DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION placement_v2_released_profile_snapshot_guard()');

        DB::statement(<<<'SQL'
            CREATE OR REPLACE FUNCTION placement_v2_attempt_guard() RETURNS trigger AS $fn$
            DECLARE
                profile_origin char(36);
                profile_home char(36);
                profile_program char(36);
                test_origin char(36);
                test_home char(36);
                test_program char(36);
                test_version_id char(36);
                profile_state text;
                version_state text;
                test_state text;
            BEGIN
                IF TG_OP = 'DELETE' THEN
                    RAISE EXCEPTION 'placement attempts are auditable history and cannot be deleted'
                        USING ERRCODE = 'check_violation';
                END IF;
                IF TG_OP = 'INSERT' THEN
                    IF NEW.lineage_version IS DISTINCT FROM 'placement-evidence-v2' OR NEW.status IS DISTINCT FROM 'in_progress'
                       OR NEW.started_at IS NULL
                       OR (NEW.delivery_mode = 'physical' AND NEW.proctor_person_id IS NULL) THEN
                        RAISE EXCEPTION 'new placement attempts require v2 in-progress lineage, a start time, and a proctor for physical delivery'
                            USING ERRCODE = 'check_violation';
                    END IF;
                ELSIF OLD.lineage_version IS DISTINCT FROM 'placement-evidence-v2' THEN
                    IF OLD.lineage_version IS DISTINCT FROM NEW.lineage_version THEN
                        RAISE EXCEPTION 'placement attempt lineage version is immutable'
                            USING ERRCODE = 'check_violation';
                    END IF;
                    RAISE EXCEPTION 'pre-lineage placement attempts are immutable historical evidence and require governed remediation'
                        USING ERRCODE = 'check_violation';
                ELSIF NEW.lineage_version IS DISTINCT FROM OLD.lineage_version
                   OR NEW.profile_id IS DISTINCT FROM OLD.profile_id
                   OR NEW.test_version_id IS DISTINCT FROM OLD.test_version_id
                   OR NEW.delivery_mode IS DISTINCT FROM OLD.delivery_mode
                   OR NEW.attempt_no IS DISTINCT FROM OLD.attempt_no
                   OR NEW.started_at IS DISTINCT FROM OLD.started_at
                   OR NEW.proctor_person_id IS DISTINCT FROM OLD.proctor_person_id
                   OR NEW.originating_branch_id IS DISTINCT FROM OLD.originating_branch_id
                   OR NEW.current_home_branch_id IS DISTINCT FROM OLD.current_home_branch_id
                   OR NEW.correlation_id IS DISTINCT FROM OLD.correlation_id THEN
                    RAISE EXCEPTION 'placement attempt provenance is immutable after creation'
                        USING ERRCODE = 'check_violation';
                END IF;

                SELECT originating_branch_id, current_home_branch_id, program_version_id, lifecycle_state
                  INTO profile_origin, profile_home, profile_program, profile_state
                  FROM placement_profiles WHERE id = NEW.profile_id;
                SELECT t.originating_branch_id, t.current_home_branch_id, t.program_version_id, t.lifecycle_state, v.id, v.lifecycle_state
                  INTO test_origin, test_home, test_program, test_state, test_version_id, version_state
                  FROM placement_test_versions v
                  JOIN placement_tests t ON t.id = v.placement_test_id
                 WHERE v.id = NEW.test_version_id;
                IF profile_origin IS NULL OR test_version_id IS NULL
                   OR NEW.originating_branch_id IS DISTINCT FROM profile_origin
                   OR NEW.current_home_branch_id IS DISTINCT FROM profile_home
                   OR test_origin IS DISTINCT FROM profile_origin
                   OR test_home IS DISTINCT FROM profile_home
                   OR (profile_program IS NOT NULL AND test_program IS NOT NULL AND profile_program IS DISTINCT FROM test_program)
                   OR (TG_OP = 'INSERT' AND (profile_state IS DISTINCT FROM 'draft' OR version_state IS DISTINCT FROM 'published' OR test_state IS DISTINCT FROM 'published')) THEN
                    RAISE EXCEPTION 'placement attempt profile, published test version, stored branch provenance, and explicit target program must agree'
                        USING ERRCODE = 'check_violation';
                END IF;
                IF TG_OP = 'INSERT' THEN
                    -- New v2 evidence may use only a complete frozen scoring
                    -- contract, including one delivery mode. This also keeps a
                    -- legacy published but partial/mixed catalog from becoming
                    -- a new authoritative decision source through raw SQL.
                    PERFORM placement_v2_assert_version_publishable(NEW.test_version_id);
                END IF;
                PERFORM placement_v2_assert_active_branch(NEW.originating_branch_id, 'attempt');

                IF TG_OP = 'UPDATE' THEN
                    IF OLD.status IN ('submitted', 'timed_out', 'cancelled') THEN
                        RAISE EXCEPTION 'terminal placement attempts are immutable evidence'
                            USING ERRCODE = 'check_violation';
                    END IF;
                    IF OLD.status IS DISTINCT FROM 'in_progress' OR NEW.status NOT IN ('submitted', 'cancelled') THEN
                        RAISE EXCEPTION 'placement attempt lifecycle transition % -> % is not permitted', OLD.status, NEW.status
                            USING ERRCODE = 'check_violation';
                    END IF;
                    IF NEW.status = 'submitted' THEN
                        IF NEW.ended_at IS NULL OR NEW.duration_seconds IS NULL
                           OR NEW.anti_tamper_hmac IS NULL
                           OR NEW.anti_tamper_hmac !~ '^[0-9a-f]{64}$'
                           OR NEW.ended_at < NEW.started_at
                           OR (NEW.delivery_mode = 'physical' AND (NEW.evidence_ref IS NULL OR trim(NEW.evidence_ref) = '')) THEN
                            RAISE EXCEPTION 'submitted placement attempts require immutable timing, HMAC, and physical evidence where applicable'
                                USING ERRCODE = 'check_violation';
                        END IF;
                        PERFORM placement_v2_assert_submittable_response_set(NEW.id, NEW.test_version_id, NEW.delivery_mode);
                    ELSIF NEW.ended_at IS NOT NULL
                       OR NEW.duration_seconds IS NOT NULL
                       OR NEW.evidence_ref IS NOT NULL
                       OR NEW.anti_tamper_hmac IS NOT NULL
                       OR NEW.tamper_flagged IS DISTINCT FROM FALSE
                       OR NEW.tamper_reason IS NOT NULL THEN
                        RAISE EXCEPTION 'a cancelled placement attempt cannot carry submitted evidence'
                            USING ERRCODE = 'check_violation';
                    END IF;
                END IF;
                RETURN NEW;
            END;
            $fn$ LANGUAGE plpgsql;
        SQL);
        DB::statement('CREATE TRIGGER placement_v2_attempt_guard_trigger BEFORE INSERT OR UPDATE OR DELETE ON placement_attempts FOR EACH ROW EXECUTE FUNCTION placement_v2_attempt_guard()');

        DB::statement(<<<'SQL'
            CREATE OR REPLACE FUNCTION placement_v2_response_guard() RETURNS trigger AS $fn$
            DECLARE
                attempt_version char(36);
                attempt_state text;
                attempt_lineage text;
                question_version char(36);
                question_state text;
            BEGIN
                IF TG_OP IS DISTINCT FROM 'INSERT' THEN
                    RETURN NEW;
                END IF;
                SELECT test_version_id, status, lineage_version
                  INTO attempt_version, attempt_state, attempt_lineage
                  FROM placement_attempts WHERE id = NEW.attempt_id;
                SELECT s.test_version_id, q.lifecycle_state INTO question_version, question_state
                  FROM placement_questions q
                  JOIN placement_sections s ON s.id = q.section_id
                 WHERE q.id = NEW.question_id;
                IF attempt_lineage IS DISTINCT FROM 'placement-evidence-v2'
                   OR attempt_state IS DISTINCT FROM 'in_progress'
                   OR question_version IS NULL
                   OR question_state IS DISTINCT FROM 'published'
                   OR question_version IS DISTINCT FROM attempt_version THEN
                    RAISE EXCEPTION 'placement responses must be appended only for an in-progress attempt and a question in its exact test version'
                        USING ERRCODE = 'check_violation';
                END IF;
                IF NEW.evidence_sha256 IS NULL OR NEW.evidence_sha256 !~ '^[0-9a-f]{64}$' THEN
                    RAISE EXCEPTION 'post-convergence placement responses require a canonical evidence SHA-256 digest'
                        USING ERRCODE = 'check_violation';
                END IF;
                RETURN NEW;
            END;
            $fn$ LANGUAGE plpgsql;
        SQL);
        DB::statement('CREATE TRIGGER placement_v2_response_guard_trigger BEFORE INSERT ON placement_responses FOR EACH ROW EXECUTE FUNCTION placement_v2_response_guard()');

        DB::statement(<<<'SQL'
            CREATE OR REPLACE FUNCTION placement_v2_section_result_guard() RETURNS trigger AS $fn$
            DECLARE
                attempt_version char(36);
                attempt_state text;
                attempt_lineage text;
                section_version char(36);
                section_component text;
                rubric_version char(36);
                rubric_component text;
                rubric_state text;
                rubric_min_score numeric;
                rubric_max_score numeric;
                rubric_cefr text;
            BEGIN
                IF TG_OP = 'DELETE' THEN
                    RAISE EXCEPTION 'placement section results are auditable evidence and cannot be deleted'
                        USING ERRCODE = 'check_violation';
                END IF;

                SELECT test_version_id, status, lineage_version
                  INTO attempt_version, attempt_state, attempt_lineage
                  FROM placement_attempts WHERE id = NEW.attempt_id;
                SELECT test_version_id, component INTO section_version, section_component
                  FROM placement_sections WHERE id = NEW.section_id;
                IF attempt_lineage IS DISTINCT FROM 'placement-evidence-v2'
                   OR attempt_state NOT IN ('in_progress', 'submitted')
                   OR section_version IS NULL
                   OR section_version IS DISTINCT FROM attempt_version
                   OR section_component IS DISTINCT FROM NEW.component THEN
                    RAISE EXCEPTION 'placement section result must belong to the attempt exact version and section component'
                        USING ERRCODE = 'check_violation';
                END IF;
                IF NEW.rubric_id IS NOT NULL THEN
                    SELECT test_version_id, component, lifecycle_state, min_score, max_score, cefr_ref
                      INTO rubric_version, rubric_component, rubric_state, rubric_min_score, rubric_max_score, rubric_cefr
                      FROM placement_rubrics WHERE id = NEW.rubric_id;
                    IF rubric_version IS NULL
                       OR rubric_version IS DISTINCT FROM attempt_version
                       OR rubric_component IS DISTINCT FROM NEW.component
                       OR rubric_state IS DISTINCT FROM 'published' THEN
                        RAISE EXCEPTION 'placement section rubric must be a published rubric in the exact attempt version/component'
                            USING ERRCODE = 'check_violation';
                    END IF;
                    IF NEW.scoring_method = 'professional' AND NEW.raw_score IS NOT NULL
                       AND (NEW.raw_score < rubric_min_score OR NEW.raw_score > rubric_max_score
                         OR upper(NEW.cefr_ref) IS DISTINCT FROM upper(rubric_cefr)) THEN
                        RAISE EXCEPTION 'professional placement score and CEFR must be exactly within its selected published rubric band'
                            USING ERRCODE = 'check_violation';
                    END IF;
                END IF;

                IF TG_OP = 'INSERT' THEN
                    IF NEW.lifecycle_state IS DISTINCT FROM 'scored' OR NEW.scoring_method IS NULL THEN
                        RAISE EXCEPTION 'new placement section results begin as a declared scored method fact'
                            USING ERRCODE = 'check_violation';
                    END IF;
                    IF NEW.scoring_method = 'automatic' THEN
                        IF attempt_state IS DISTINCT FROM 'in_progress'
                           OR NEW.raw_score IS NULL OR NEW.weighted_score IS NULL
                           OR NEW.weighted_score < 0 OR NEW.weighted_score > 100
                           OR NEW.adjusted_score IS NOT NULL
                           OR NEW.cefr_ref IS NOT NULL
                           OR NEW.scored_by IS NOT NULL
                           OR NEW.moderated_by IS NOT NULL
                           OR NEW.approved_by IS NOT NULL
                           OR NEW.rubric_id IS NOT NULL THEN
                            RAISE EXCEPTION 'automatic placement results require only an in-progress server-derived score and no fabricated human scorer'
                                USING ERRCODE = 'check_violation';
                        END IF;
                        PERFORM placement_v2_assert_auto_score_from_responses(NEW.attempt_id, NEW.section_id, NEW.raw_score, NEW.weighted_score);
                    ELSIF NEW.scoring_method = 'professional' THEN
                        IF attempt_state IS DISTINCT FROM 'submitted' THEN
                            RAISE EXCEPTION 'professional placement result evidence may be created only after the attempt is submitted'
                                USING ERRCODE = 'check_violation';
                        END IF;
                        IF NEW.raw_score IS NULL THEN
                            IF NEW.scored_by IS NOT NULL OR NEW.rubric_id IS NOT NULL OR NEW.cefr_ref IS NOT NULL
                               OR NEW.adjusted_score IS NOT NULL OR NEW.weighted_score IS NOT NULL THEN
                                RAISE EXCEPTION 'unscored professional placement stubs cannot carry a scorer, rubric, or derived score'
                                    USING ERRCODE = 'check_violation';
                            END IF;
                        ELSIF NEW.scored_by IS NULL OR NEW.rubric_id IS NULL OR NEW.cefr_ref IS NULL
                           OR NEW.adjusted_score IS NOT NULL OR NEW.weighted_score IS NOT NULL
                           OR NEW.raw_score < 0 OR NEW.raw_score > 100
                           OR NEW.rationale IS NULL OR trim(NEW.rationale) = '' THEN
                            RAISE EXCEPTION 'professional placement results require a bounded rubric score, CEFR, rationale, actual scorer, and no ungoverned derived score'
                                USING ERRCODE = 'check_violation';
                        END IF;
                    ELSE
                        RAISE EXCEPTION 'unknown placement scoring method'
                            USING ERRCODE = 'check_violation';
                    END IF;
                    RETURN NEW;
                END IF;

                IF OLD.scoring_method IS NULL THEN
                    RAISE EXCEPTION 'pre-lineage placement section results are immutable historical evidence and require governed remediation'
                        USING ERRCODE = 'check_violation';
                END IF;
                IF OLD.attempt_id IS DISTINCT FROM NEW.attempt_id
                   OR OLD.section_id IS DISTINCT FROM NEW.section_id
                   OR OLD.component IS DISTINCT FROM NEW.component
                   OR OLD.scoring_method IS DISTINCT FROM NEW.scoring_method THEN
                    RAISE EXCEPTION 'placement section result lineage is immutable'
                        USING ERRCODE = 'check_violation';
                END IF;
                IF OLD.lifecycle_state = 'approved' THEN
                    RAISE EXCEPTION 'approved placement section results are immutable'
                        USING ERRCODE = 'check_violation';
                END IF;
                IF OLD.lifecycle_state = 'moderated' THEN
                    IF NEW.lifecycle_state IS DISTINCT FROM 'approved'
                       OR NEW.approved_by IS NULL
                       OR NEW.approved_by = NEW.moderated_by
                       OR (NEW.scored_by IS NOT NULL AND NEW.approved_by = NEW.scored_by)
                       OR OLD.raw_score IS DISTINCT FROM NEW.raw_score
                       OR OLD.adjusted_score IS DISTINCT FROM NEW.adjusted_score
                       OR OLD.weighted_score IS DISTINCT FROM NEW.weighted_score
                       OR OLD.rubric_id IS DISTINCT FROM NEW.rubric_id
                       OR OLD.cefr_ref IS DISTINCT FROM NEW.cefr_ref
                       OR OLD.scored_by IS DISTINCT FROM NEW.scored_by
                       OR OLD.moderated_by IS DISTINCT FROM NEW.moderated_by
                       OR OLD.rationale IS DISTINCT FROM NEW.rationale THEN
                        RAISE EXCEPTION 'a moderated placement result may only receive an independent approval'
                            USING ERRCODE = 'check_violation';
                    END IF;
                    RETURN NEW;
                END IF;
                IF OLD.lifecycle_state = 'scored' AND OLD.raw_score IS NULL THEN
                    IF NEW.lifecycle_state IS DISTINCT FROM 'scored'
                       OR NEW.scoring_method IS DISTINCT FROM 'professional'
                       OR NEW.raw_score IS NULL
                       OR NEW.raw_score < 0 OR NEW.raw_score > 100
                       OR NEW.rubric_id IS NULL
                       OR NEW.cefr_ref IS NULL
                       OR NEW.scored_by IS NULL
                       OR NEW.adjusted_score IS NOT NULL
                       OR NEW.weighted_score IS NOT NULL
                       OR NEW.rationale IS NULL OR trim(NEW.rationale) = ''
                       OR NEW.moderated_by IS NOT NULL
                       OR NEW.approved_by IS NOT NULL THEN
                        RAISE EXCEPTION 'an unscored professional placement stub may be completed exactly once by its actual scorer'
                            USING ERRCODE = 'check_violation';
                    END IF;
                    RETURN NEW;
                END IF;
                IF OLD.lifecycle_state = 'scored' THEN
                    IF NEW.lifecycle_state IS DISTINCT FROM 'moderated'
                       OR NEW.moderated_by IS NULL
                       OR (OLD.scored_by IS NOT NULL AND NEW.moderated_by = OLD.scored_by)
                       OR OLD.raw_score IS DISTINCT FROM NEW.raw_score
                       OR OLD.adjusted_score IS DISTINCT FROM NEW.adjusted_score
                       OR OLD.weighted_score IS DISTINCT FROM NEW.weighted_score
                       OR OLD.rubric_id IS DISTINCT FROM NEW.rubric_id
                       OR OLD.cefr_ref IS DISTINCT FROM NEW.cefr_ref
                       OR OLD.scored_by IS DISTINCT FROM NEW.scored_by
                       OR OLD.rationale IS DISTINCT FROM NEW.rationale
                       OR NEW.approved_by IS NOT NULL THEN
                        RAISE EXCEPTION 'a completed placement result may only receive independent moderation'
                            USING ERRCODE = 'check_violation';
                    END IF;
                    RETURN NEW;
                END IF;

                RAISE EXCEPTION 'placement section result lifecycle transition % -> % is not permitted', OLD.lifecycle_state, NEW.lifecycle_state
                    USING ERRCODE = 'check_violation';
            END;
            $fn$ LANGUAGE plpgsql;
        SQL);
        DB::statement('CREATE TRIGGER placement_v2_section_result_guard_trigger BEFORE INSERT OR UPDATE OR DELETE ON placement_section_results FOR EACH ROW EXECUTE FUNCTION placement_v2_section_result_guard()');

        DB::statement(<<<'SQL'
            CREATE OR REPLACE FUNCTION placement_v2_recommendation_guard() RETURNS trigger AS $fn$
            DECLARE
                attempt_profile char(36);
                attempt_state text;
                attempt_lineage text;
                level_program char(36);
                profile_state text;
                profile_lineage text;
                profile_program char(36);
                profile_recommendation char(36);
                test_program char(36);
            BEGIN
                IF TG_OP IS DISTINCT FROM 'INSERT' THEN
                    RETURN NEW;
                END IF;
                IF NEW.lineage_version IS DISTINCT FROM 'placement-evidence-v2'
                   OR NEW.attempt_id IS NULL
                   OR NEW.program_version_id IS NULL
                   OR NEW.recommended_class_id IS NOT NULL
                   OR NEW.recommended_offering_id IS NOT NULL
                   OR NEW.recommended_by IS NULL
                   OR trim(NEW.recommended_by) = ''
                   OR NEW.rationale IS NULL
                   OR trim(NEW.rationale) = '' THEN
                    RAISE EXCEPTION 'new placement recommendations require accountable exact attempt/program lineage and cannot assign a class or offering'
                        USING ERRCODE = 'check_violation';
                END IF;
                SELECT profile_id, status, lineage_version
                  INTO attempt_profile, attempt_state, attempt_lineage
                  FROM placement_attempts WHERE id = NEW.attempt_id;
                SELECT p.lifecycle_state, p.lineage_version, p.program_version_id,
                       p.placement_recommendation_id, t.program_version_id
                  INTO profile_state, profile_lineage, profile_program,
                       profile_recommendation, test_program
                  FROM placement_profiles p
                  JOIN placement_attempts a ON a.id = NEW.attempt_id
                  JOIN placement_test_versions v ON v.id = a.test_version_id
                  JOIN placement_tests t ON t.id = v.placement_test_id
                 WHERE p.id = NEW.profile_id;
                SELECT program_version_id INTO level_program
                  FROM program_version_levels WHERE id = NEW.recommended_level_id;
                IF attempt_profile IS NULL
                   OR attempt_profile IS DISTINCT FROM NEW.profile_id
                   OR attempt_state IS DISTINCT FROM 'submitted'
                   OR attempt_lineage IS DISTINCT FROM 'placement-evidence-v2'
                   OR profile_state IS DISTINCT FROM 'scored'
                   OR profile_lineage IS DISTINCT FROM 'placement-evidence-v2'
                   OR profile_recommendation IS NOT NULL
                   OR (profile_program IS NOT NULL AND test_program IS NOT NULL AND profile_program IS DISTINCT FROM test_program)
                   OR NEW.program_version_id IS DISTINCT FROM COALESCE(profile_program, test_program)
                   OR level_program IS NULL
                   OR level_program IS DISTINCT FROM NEW.program_version_id THEN
                    RAISE EXCEPTION 'placement recommendation must be an initial scored-profile decision for the exact attempt and target program version'
                        USING ERRCODE = 'check_violation';
                END IF;
                PERFORM placement_v2_assert_complete_result_set(NEW.attempt_id);
                PERFORM placement_v2_assert_recommendation_derivation(
                    NEW.attempt_id,
                    NEW.program_version_id,
                    NEW.recommended_level_id,
                    NEW.model_version,
                    NEW.score_snapshot
                );
                RETURN NEW;
            END;
            $fn$ LANGUAGE plpgsql;
        SQL);
        DB::statement('CREATE TRIGGER placement_v2_recommendation_guard_trigger BEFORE INSERT ON placement_recommendations FOR EACH ROW EXECUTE FUNCTION placement_v2_recommendation_guard()');

        DB::statement(<<<'SQL'
            CREATE OR REPLACE FUNCTION placement_v2_snapshot_guard() RETURNS trigger AS $fn$
            DECLARE
                profile_person char(36);
                profile_visitor char(36);
                profile_origin char(36);
                profile_home char(36);
                profile_state text;
                profile_lineage text;
                profile_recommendation char(36);
                recommendation_profile char(36);
                recommendation_attempt char(36);
                recommendation_program char(36);
                recommendation_level char(36);
                recommendation_lineage text;
                attempt_profile char(36);
                attempt_lineage text;
                attempt_state text;
                predecessor_person char(36);
            BEGIN
                IF TG_OP IS DISTINCT FROM 'INSERT' THEN
                    RETURN NEW;
                END IF;
                IF NEW.snapshot_schema_version IS DISTINCT FROM 'academic-context-snapshot-v2'
                   OR NEW.version_no <> 1
                   OR NEW.signature_algorithm IS DISTINCT FROM 'hmac-sha256'
                   OR NEW.signing_key_version IS DISTINCT FROM 'app_key_v2'
                   OR NEW.signature IS NULL
                   OR NEW.signature !~ '^[0-9a-fA-F]{64}$'
                   OR NEW.payload_sha256 IS NULL
                   OR NEW.payload_sha256 !~ '^[0-9a-fA-F]{64}$'
                   OR NEW.payload_canonical_json IS NULL
                   OR trim(NEW.payload_canonical_json) = ''
                   OR NEW.signed_by IS NULL
                   OR trim(NEW.signed_by) = ''
                   OR NEW.signed_at IS NULL
                   OR NEW.recommended_class_id IS NOT NULL
                   OR NEW.recommended_offering_id IS NOT NULL
                   OR NEW.academic_period_id IS NOT NULL THEN
                    RAISE EXCEPTION 'new academic eligibility snapshots establish signed version-one level eligibility only, not a Placement-owned class/offering assignment'
                        USING ERRCODE = 'check_violation';
                END IF;
                -- The append-only graph has no mutable "current" flag. Lock
                -- a stable per-person key so two releases cannot append roots
                -- or successors concurrently and create ambiguous lineage.
                PERFORM pg_advisory_xact_lock(hashtext(NEW.person_id));
                IF NEW.supersedes_snapshot_id IS NULL THEN
                    IF EXISTS (SELECT 1 FROM academic_eligibility_snapshots WHERE person_id = NEW.person_id) THEN
                        RAISE EXCEPTION 'a new eligibility snapshot must supersede the same-person current lineage tail'
                            USING ERRCODE = 'check_violation';
                    END IF;
                ELSIF NEW.supersedes_snapshot_id = NEW.id
                   OR EXISTS (SELECT 1 FROM academic_eligibility_snapshots WHERE supersedes_snapshot_id = NEW.supersedes_snapshot_id) THEN
                    RAISE EXCEPTION 'an eligibility snapshot must append exactly once to an unsuperseded lineage tail'
                        USING ERRCODE = 'check_violation';
                END IF;
                SELECT person_id, visitor_id, originating_branch_id, current_home_branch_id, lifecycle_state, lineage_version, placement_recommendation_id
                  INTO profile_person, profile_visitor, profile_origin, profile_home, profile_state, profile_lineage, profile_recommendation
                  FROM placement_profiles WHERE id = NEW.placement_profile_id;
                SELECT profile_id, attempt_id, program_version_id, recommended_level_id, lineage_version
                  INTO recommendation_profile, recommendation_attempt, recommendation_program, recommendation_level, recommendation_lineage
                  FROM placement_recommendations WHERE id = NEW.placement_recommendation_id;
                SELECT profile_id, lineage_version, status
                  INTO attempt_profile, attempt_lineage, attempt_state
                  FROM placement_attempts WHERE id = recommendation_attempt;
                IF profile_person IS NULL
                   OR profile_state IS DISTINCT FROM 'released'
                   OR profile_lineage IS DISTINCT FROM 'placement-evidence-v2'
                   OR profile_recommendation IS DISTINCT FROM NEW.placement_recommendation_id
                   OR NEW.person_id IS DISTINCT FROM profile_person
                   OR NEW.visitor_id IS DISTINCT FROM profile_visitor
                   OR NEW.originating_branch_id IS DISTINCT FROM profile_origin
                   OR NEW.current_home_branch_id IS DISTINCT FROM profile_home
                   OR recommendation_profile IS DISTINCT FROM NEW.placement_profile_id
                   OR recommendation_lineage IS DISTINCT FROM 'placement-evidence-v2'
                   OR recommendation_attempt IS NULL
                   OR attempt_profile IS DISTINCT FROM NEW.placement_profile_id
                   OR attempt_lineage IS DISTINCT FROM 'placement-evidence-v2'
                   OR attempt_state IS DISTINCT FROM 'submitted'
                   OR recommendation_program IS DISTINCT FROM NEW.program_version_id
                   OR recommendation_level IS DISTINCT FROM NEW.recommended_level_id THEN
                    RAISE EXCEPTION 'eligibility snapshot must bind the released profile, its exact recommendation, person, program, level, and branch provenance'
                        USING ERRCODE = 'check_violation';
                END IF;
                PERFORM placement_v2_assert_approved_result_set(recommendation_attempt);
                IF NEW.supersedes_snapshot_id IS NOT NULL THEN
                    SELECT person_id INTO predecessor_person
                      FROM academic_eligibility_snapshots WHERE id = NEW.supersedes_snapshot_id;
                    IF predecessor_person IS NULL OR predecessor_person IS DISTINCT FROM NEW.person_id THEN
                        RAISE EXCEPTION 'an eligibility snapshot may supersede only the same person previous snapshot'
                            USING ERRCODE = 'check_violation';
                    END IF;
                END IF;
                RETURN NEW;
            END;
            $fn$ LANGUAGE plpgsql;
        SQL);
        DB::statement('CREATE TRIGGER placement_v2_snapshot_guard_trigger BEFORE INSERT ON academic_eligibility_snapshots FOR EACH ROW EXECUTE FUNCTION placement_v2_snapshot_guard()');

        // Downstream links carry a consumed immutable fact, not merely two
        // unrelated foreign keys. The profile may later be superseded; the
        // exact snapshot remains valid historical evidence.
        DB::statement(<<<'SQL'
            CREATE OR REPLACE FUNCTION placement_v2_applicant_evidence_guard() RETURNS trigger AS $fn$
            DECLARE
                profile_person char(36);
                profile_state text;
                profile_lineage text;
                profile_snapshot char(36);
                snapshot_profile char(36);
                snapshot_person char(36);
                snapshot_origin char(36);
                snapshot_schema text;
                snapshot_key_version text;
                snapshot_signature text;
                snapshot_digest text;
            BEGIN
                -- The evidence selected for an admission file is part of its
                -- provenance. There is deliberately no generic "replace
                -- placement" operation: changing it would rewrite the fact
                -- later consumed by the admission decision. A later retake
                -- needs an explicit append-only reapplication/evidence model;
                -- it must never silently replace this pointer.
                IF TG_OP = 'UPDATE'
                   AND (NEW.placement_profile_id IS DISTINCT FROM OLD.placement_profile_id
                        OR NEW.academic_eligibility_snapshot_id IS DISTINCT FROM OLD.academic_eligibility_snapshot_id) THEN
                    RAISE EXCEPTION 'applicant placement evidence is immutable after registration; open a governed new application for a later retake'
                        USING ERRCODE = 'check_violation';
                END IF;
                IF (NEW.placement_profile_id IS NULL) <> (NEW.academic_eligibility_snapshot_id IS NULL) THEN
                    RAISE EXCEPTION 'an applicant placement profile and eligibility snapshot must be linked together'
                        USING ERRCODE = 'check_violation';
                END IF;
                IF NEW.placement_profile_id IS NULL THEN
                    RETURN NEW;
                END IF;
                SELECT person_id, lifecycle_state, lineage_version, academic_eligibility_snapshot_id
                  INTO profile_person, profile_state, profile_lineage, profile_snapshot
                  FROM placement_profiles WHERE id = NEW.placement_profile_id;
                SELECT placement_profile_id, person_id, originating_branch_id, snapshot_schema_version,
                       signing_key_version, signature, payload_sha256
                  INTO snapshot_profile, snapshot_person, snapshot_origin, snapshot_schema,
                       snapshot_key_version, snapshot_signature, snapshot_digest
                  FROM academic_eligibility_snapshots WHERE id = NEW.academic_eligibility_snapshot_id;
                IF profile_person IS NULL
                   OR profile_person IS DISTINCT FROM NEW.person_id
                   OR profile_lineage IS DISTINCT FROM 'placement-evidence-v2'
                   OR profile_snapshot IS DISTINCT FROM NEW.academic_eligibility_snapshot_id
                   OR snapshot_profile IS DISTINCT FROM NEW.placement_profile_id
                   OR snapshot_person IS DISTINCT FROM NEW.person_id
                   OR snapshot_origin IS DISTINCT FROM NEW.originating_branch_id
                   OR snapshot_schema IS DISTINCT FROM 'academic-context-snapshot-v2'
                   OR snapshot_key_version IS DISTINCT FROM 'app_key_v2'
                   OR snapshot_signature IS NULL OR snapshot_signature !~ '^[0-9a-fA-F]{64}$'
                   OR snapshot_digest IS NULL OR snapshot_digest !~ '^[0-9a-fA-F]{64}$'
                   OR (TG_OP = 'INSERT' AND profile_state IS DISTINCT FROM 'released')
                   OR (TG_OP = 'UPDATE' AND OLD.placement_profile_id IS NULL AND profile_state IS DISTINCT FROM 'released') THEN
                    RAISE EXCEPTION 'an applicant placement evidence link must consume the profile exact signed v2 snapshot at released state and matching operational branch'
                        USING ERRCODE = 'check_violation';
                END IF;
                RETURN NEW;
            END;
            $fn$ LANGUAGE plpgsql;
        SQL);
        DB::statement('CREATE TRIGGER placement_v2_applicant_evidence_guard_trigger BEFORE INSERT OR UPDATE OF person_id, placement_profile_id, academic_eligibility_snapshot_id, originating_branch_id ON applicants FOR EACH ROW EXECUTE FUNCTION placement_v2_applicant_evidence_guard()');

        DB::statement(<<<'SQL'
            CREATE OR REPLACE FUNCTION placement_v2_student_evidence_guard() RETURNS trigger AS $fn$
            DECLARE
                profile_person char(36);
                profile_state text;
                profile_lineage text;
                profile_snapshot char(36);
                snapshot_profile char(36);
                snapshot_person char(36);
                snapshot_origin char(36);
                snapshot_schema text;
                snapshot_key_version text;
                snapshot_signature text;
                snapshot_digest text;
            BEGIN
                -- Student entry eligibility is immutable admission provenance,
                -- not a pointer to a person's latest test. Any replacement
                -- would silently change the entry fact behind enrollment,
                -- progression, and official documents.
                IF TG_OP = 'UPDATE'
                   AND (NEW.placement_profile_id IS DISTINCT FROM OLD.placement_profile_id
                        OR NEW.academic_eligibility_snapshot_id IS DISTINCT FROM OLD.academic_eligibility_snapshot_id) THEN
                    RAISE EXCEPTION 'Student placement evidence is immutable after admission conversion'
                        USING ERRCODE = 'check_violation';
                END IF;
                IF (NEW.placement_profile_id IS NULL) <> (NEW.academic_eligibility_snapshot_id IS NULL) THEN
                    RAISE EXCEPTION 'a Student placement profile and eligibility snapshot must be linked together'
                        USING ERRCODE = 'check_violation';
                END IF;
                IF NEW.placement_profile_id IS NULL THEN
                    RETURN NEW;
                END IF;
                SELECT person_id, lifecycle_state, lineage_version, academic_eligibility_snapshot_id
                  INTO profile_person, profile_state, profile_lineage, profile_snapshot
                  FROM placement_profiles WHERE id = NEW.placement_profile_id;
                SELECT placement_profile_id, person_id, originating_branch_id, snapshot_schema_version,
                       signing_key_version, signature, payload_sha256
                  INTO snapshot_profile, snapshot_person, snapshot_origin, snapshot_schema,
                       snapshot_key_version, snapshot_signature, snapshot_digest
                  FROM academic_eligibility_snapshots WHERE id = NEW.academic_eligibility_snapshot_id;
                IF profile_person IS NULL
                   OR profile_person IS DISTINCT FROM NEW.person_id
                   OR profile_lineage IS DISTINCT FROM 'placement-evidence-v2'
                   OR profile_snapshot IS DISTINCT FROM NEW.academic_eligibility_snapshot_id
                   OR snapshot_profile IS DISTINCT FROM NEW.placement_profile_id
                   OR snapshot_person IS DISTINCT FROM NEW.person_id
                   OR snapshot_origin IS DISTINCT FROM NEW.originating_branch_id
                   OR snapshot_schema IS DISTINCT FROM 'academic-context-snapshot-v2'
                   OR snapshot_key_version IS DISTINCT FROM 'app_key_v2'
                   OR snapshot_signature IS NULL OR snapshot_signature !~ '^[0-9a-fA-F]{64}$'
                   OR snapshot_digest IS NULL OR snapshot_digest !~ '^[0-9a-fA-F]{64}$'
                   OR (TG_OP = 'INSERT' AND profile_state IS DISTINCT FROM 'released')
                   OR (TG_OP = 'UPDATE' AND OLD.placement_profile_id IS NULL AND profile_state IS DISTINCT FROM 'released') THEN
                    RAISE EXCEPTION 'a Student placement evidence link must consume the profile exact signed v2 snapshot at released state and matching operational branch'
                        USING ERRCODE = 'check_violation';
                END IF;
                RETURN NEW;
            END;
            $fn$ LANGUAGE plpgsql;
        SQL);
        DB::statement('CREATE TRIGGER placement_v2_student_evidence_guard_trigger BEFORE INSERT OR UPDATE OF person_id, placement_profile_id, academic_eligibility_snapshot_id, originating_branch_id ON students FOR EACH ROW EXECUTE FUNCTION placement_v2_student_evidence_guard()');

        DB::statement(<<<'SQL'
            CREATE OR REPLACE FUNCTION placement_v2_enrollment_evidence_guard() RETURNS trigger AS $fn$
            DECLARE
                student_person char(36);
                student_snapshot char(36);
                student_profile char(36);
                snapshot_person char(36);
                snapshot_profile char(36);
                snapshot_schema text;
                snapshot_key_version text;
                snapshot_signature text;
                snapshot_digest text;
            BEGIN
                -- Enrollment stores the entry evidence consumed at its own
                -- creation. It is append-only provenance, not a mutable cache
                -- of whatever eligibility currently appears on Student.
                IF TG_OP = 'UPDATE'
                   AND NEW.academic_eligibility_snapshot_id IS DISTINCT FROM OLD.academic_eligibility_snapshot_id THEN
                    RAISE EXCEPTION 'enrollment eligibility evidence is immutable after enrollment creation'
                        USING ERRCODE = 'check_violation';
                END IF;
                IF NEW.academic_eligibility_snapshot_id IS NULL THEN
                    RETURN NEW;
                END IF;
                SELECT person_id, placement_profile_id, academic_eligibility_snapshot_id
                  INTO student_person, student_profile, student_snapshot
                  FROM students WHERE id = NEW.student_id;
                SELECT person_id, placement_profile_id, snapshot_schema_version, signing_key_version,
                       signature, payload_sha256
                  INTO snapshot_person, snapshot_profile, snapshot_schema, snapshot_key_version,
                       snapshot_signature, snapshot_digest
                  FROM academic_eligibility_snapshots WHERE id = NEW.academic_eligibility_snapshot_id;
                IF student_person IS NULL
                   OR snapshot_person IS NULL
                   OR snapshot_person IS DISTINCT FROM student_person
                   OR student_snapshot IS DISTINCT FROM NEW.academic_eligibility_snapshot_id
                   OR student_profile IS DISTINCT FROM snapshot_profile
                   OR snapshot_schema IS DISTINCT FROM 'academic-context-snapshot-v2'
                   OR snapshot_key_version IS DISTINCT FROM 'app_key_v2'
                   OR snapshot_signature IS NULL OR snapshot_signature !~ '^[0-9a-fA-F]{64}$'
                   OR snapshot_digest IS NULL OR snapshot_digest !~ '^[0-9a-fA-F]{64}$' THEN
                    RAISE EXCEPTION 'an enrollment eligibility snapshot must be the exact signed v2 snapshot consumed by its Student'
                        USING ERRCODE = 'check_violation';
                END IF;
                RETURN NEW;
            END;
            $fn$ LANGUAGE plpgsql;
        SQL);
        DB::statement('CREATE TRIGGER placement_v2_enrollment_evidence_guard_trigger BEFORE INSERT OR UPDATE OF student_id, academic_eligibility_snapshot_id ON enrollments FOR EACH ROW EXECUTE FUNCTION placement_v2_enrollment_evidence_guard()');

        // The command validates this too, but a raw version publication must
        // not bypass the complete, disjoint scoring contract under races.
        DB::statement(<<<'SQL'
            CREATE OR REPLACE FUNCTION placement_v2_assert_version_publishable(p_version_id char(36)) RETURNS void AS $fn$
            DECLARE
                component_name text;
                parent_test_state text;
                section_row placement_sections%ROWTYPE;
                section_count integer;
                delivery_mode_count integer;
                mismatched_question_count integer;
                question_count integer;
                rubric_count integer;
                nonpublished_question_count integer;
                nonpublished_rubric_count integer;
                legacy_media_ref_count integer;
                invalid_active_media_count integer;
                expected_minimum numeric(6,2);
                rubric_row placement_rubrics%ROWTYPE;
            BEGIN
                SELECT t.lifecycle_state INTO parent_test_state
                  FROM placement_test_versions v
                  JOIN placement_tests t ON t.id = v.placement_test_id
                 WHERE v.id = p_version_id
                 FOR KEY SHARE OF t;
                IF parent_test_state IS DISTINCT FROM 'published' THEN
                    RAISE EXCEPTION 'only a published placement test may publish a version'
                        USING ERRCODE = 'check_violation';
                END IF;

                SELECT count(*) INTO section_count
                  FROM placement_sections WHERE test_version_id = p_version_id;
                IF section_count <> 5 THEN
                    RAISE EXCEPTION 'a published placement version requires exactly five canonical component sections'
                        USING ERRCODE = 'check_violation';
                END IF;
                SELECT count(DISTINCT delivery_mode) INTO delivery_mode_count
                  FROM placement_sections WHERE test_version_id = p_version_id;
                IF delivery_mode_count <> 1 THEN
                    RAISE EXCEPTION 'a published placement version requires one coherent delivery mode for every section'
                        USING ERRCODE = 'check_violation';
                END IF;
                SELECT count(*) INTO mismatched_question_count
                  FROM placement_questions q
                  JOIN placement_sections s ON s.id = q.section_id
                 WHERE s.test_version_id = p_version_id
                   AND q.component IS DISTINCT FROM s.component;
                IF mismatched_question_count <> 0 THEN
                    RAISE EXCEPTION 'placement questions must use their parent section canonical component'
                        USING ERRCODE = 'check_violation';
                END IF;
                -- Published versions cannot retain the legacy direct media
                -- pointer. Active checksummed attachment rows are the one
                -- authoritative media representation for a question.
                SELECT count(*) INTO legacy_media_ref_count
                  FROM placement_questions q
                  JOIN placement_sections s ON s.id = q.section_id
                 WHERE s.test_version_id = p_version_id
                   AND q.media_ref IS NOT NULL;
                IF legacy_media_ref_count <> 0 THEN
                    RAISE EXCEPTION 'a published placement version must use checksummed placement question media rather than legacy media_ref'
                        USING ERRCODE = 'check_violation';
                END IF;
                SELECT count(*) INTO invalid_active_media_count
                  FROM placement_question_media m
                  JOIN placement_questions q ON q.id = m.question_id
                  JOIN placement_sections s ON s.id = q.section_id
                 WHERE s.test_version_id = p_version_id
                   AND m.lifecycle_state = 'active'
                   AND (trim(m.uri) = '' OR trim(m.media_type) = '' OR trim(m.mime_type) = ''
                     OR m.sha256 IS NULL OR m.sha256 !~ '^[0-9a-f]{64}$');
                IF invalid_active_media_count <> 0 THEN
                    RAISE EXCEPTION 'active placement question media must be complete immutable checksummed catalog evidence before publication'
                        USING ERRCODE = 'check_violation';
                END IF;

                FOREACH component_name IN ARRAY ARRAY['grammar', 'reading', 'listening', 'writing', 'speaking'] LOOP
                    SELECT * INTO section_row FROM placement_sections
                     WHERE test_version_id = p_version_id AND component = component_name;
                    IF NOT FOUND OR section_row.lifecycle_state IS DISTINCT FROM 'published' THEN
                        RAISE EXCEPTION 'a published placement version requires one published % section', component_name
                            USING ERRCODE = 'check_violation';
                    END IF;
                    SELECT count(*), count(*) FILTER (WHERE lifecycle_state IS DISTINCT FROM 'published')
                      INTO question_count, nonpublished_question_count
                      FROM placement_questions WHERE section_id = section_row.id;
                    IF question_count = 0 OR nonpublished_question_count <> 0 THEN
                        RAISE EXCEPTION 'published placement section % requires only published questions', section_row.code
                            USING ERRCODE = 'check_violation';
                    END IF;
                    IF (NOT section_row.can_auto_score AND section_row.delivery_mode IS DISTINCT FROM 'physical' AND section_row.component NOT IN ('writing', 'speaking'))
                       OR EXISTS (
                           SELECT 1 FROM placement_questions q
                            WHERE q.section_id = section_row.id
                              AND (q.component IS DISTINCT FROM section_row.component
                                OR (section_row.can_auto_score AND (q.question_type NOT IN ('mcq', 'short_answer') OR q.correct_answer IS NULL OR trim(q.correct_answer) = ''))
                                OR (NOT section_row.can_auto_score AND (
                                    q.correct_answer IS NOT NULL
                                    OR (section_row.delivery_mode IS DISTINCT FROM 'physical' AND q.question_type NOT IN ('essay', 'speaking'))
                                )))
                       ) THEN
                        RAISE EXCEPTION 'placement section % includes component or scoring evidence incompatible with its scoring method', section_row.code
                            USING ERRCODE = 'check_violation';
                    END IF;

                    SELECT count(*), count(*) FILTER (WHERE lifecycle_state IS DISTINCT FROM 'published')
                      INTO rubric_count, nonpublished_rubric_count
                      FROM placement_rubrics WHERE test_version_id = p_version_id AND component = component_name;
                    IF rubric_count = 0 OR nonpublished_rubric_count <> 0 THEN
                        RAISE EXCEPTION 'published placement component % requires only published rubrics', component_name
                            USING ERRCODE = 'check_violation';
                    END IF;
                    expected_minimum := 0.00;
                    FOR rubric_row IN
                        SELECT * FROM placement_rubrics
                         WHERE test_version_id = p_version_id AND component = component_name
                         ORDER BY min_score, max_score, id
                    LOOP
                        IF rubric_row.min_score <> expected_minimum
                           OR rubric_row.max_score < rubric_row.min_score THEN
                            RAISE EXCEPTION 'placement % rubrics must be contiguous, non-overlapping coverage from 0 to 100', component_name
                                USING ERRCODE = 'check_violation';
                        END IF;
                        expected_minimum := round(rubric_row.max_score + 0.01, 2);
                    END LOOP;
                    IF expected_minimum <> 100.01 THEN
                        RAISE EXCEPTION 'placement % rubrics must end at 100', component_name
                            USING ERRCODE = 'check_violation';
                    END IF;
                END LOOP;
            END;
            $fn$ LANGUAGE plpgsql;
        SQL);
        DB::statement(<<<'SQL'
            CREATE OR REPLACE FUNCTION placement_v2_version_publish_guard() RETURNS trigger AS $fn$
            BEGIN
                IF OLD.lifecycle_state = 'draft' AND NEW.lifecycle_state = 'published' THEN
                    PERFORM placement_v2_assert_version_publishable(NEW.id);
                END IF;
                RETURN NEW;
            END;
            $fn$ LANGUAGE plpgsql;
        SQL);
        DB::statement('CREATE TRIGGER placement_v2_version_publish_guard_trigger BEFORE UPDATE OF lifecycle_state ON placement_test_versions FOR EACH ROW EXECUTE FUNCTION placement_v2_version_publish_guard()');

        // A parent version freezes all catalog descendants. Individual
        // published descendants may only transition to retired while their
        // parent is still draft; their scoring content is never rewritten.
        DB::statement(<<<'SQL'
            CREATE OR REPLACE FUNCTION placement_v2_catalog_section_guard() RETURNS trigger AS $fn$
            DECLARE parent_state text;
            BEGIN
                IF TG_OP = 'DELETE' THEN
                    RAISE EXCEPTION 'placement catalog sections are auditable and cannot be deleted'
                        USING ERRCODE = 'check_violation';
                END IF;
                IF trim(NEW.code) = '' OR trim(NEW.name) = ''
                   OR (NOT NEW.can_auto_score AND NEW.delivery_mode IS DISTINCT FROM 'physical' AND NEW.component NOT IN ('writing', 'speaking'))
                   OR (TG_OP = 'INSERT' AND NEW.lifecycle_state IS DISTINCT FROM 'draft') THEN
                    RAISE EXCEPTION 'new placement sections require named draft content; digital professional scoring is limited to writing or speaking'
                        USING ERRCODE = 'check_violation';
                END IF;
                SELECT lifecycle_state INTO parent_state FROM placement_test_versions
                 WHERE id = NEW.test_version_id FOR UPDATE;
                IF parent_state IS NULL OR parent_state IS DISTINCT FROM 'draft' THEN
                    RAISE EXCEPTION 'placement catalog section changes require a draft parent test version'
                        USING ERRCODE = 'check_violation';
                END IF;
                IF TG_OP = 'UPDATE' THEN
                    IF OLD.lifecycle_state = 'retired' THEN
                        RAISE EXCEPTION 'retired placement sections are immutable catalog history'
                            USING ERRCODE = 'check_violation';
                    END IF;
                    IF OLD.lifecycle_state = 'published' AND (
                        NEW.test_version_id IS DISTINCT FROM OLD.test_version_id
                        OR NEW.code IS DISTINCT FROM OLD.code
                        OR NEW.name IS DISTINCT FROM OLD.name
                        OR NEW.component IS DISTINCT FROM OLD.component
                        OR NEW.section_order IS DISTINCT FROM OLD.section_order
                        OR NEW.time_minutes IS DISTINCT FROM OLD.time_minutes
                        OR NEW.delivery_mode IS DISTINCT FROM OLD.delivery_mode
                        OR NEW.can_auto_score IS DISTINCT FROM OLD.can_auto_score
                        OR NEW.lifecycle_state IS DISTINCT FROM 'retired'
                    ) THEN
                        RAISE EXCEPTION 'published placement section content is immutable; it may only retire before parent publication'
                            USING ERRCODE = 'check_violation';
                    END IF;
                END IF;
                RETURN NEW;
            END;
            $fn$ LANGUAGE plpgsql;
        SQL);
        DB::statement('CREATE TRIGGER placement_v2_catalog_section_guard_trigger BEFORE INSERT OR UPDATE OR DELETE ON placement_sections FOR EACH ROW EXECUTE FUNCTION placement_v2_catalog_section_guard()');

        DB::statement(<<<'SQL'
            CREATE OR REPLACE FUNCTION placement_v2_catalog_question_guard() RETURNS trigger AS $fn$
            DECLARE parent_state text;
            DECLARE section_state text;
            DECLARE section_component text;
            DECLARE section_auto boolean;
            DECLARE section_delivery text;
            BEGIN
                IF TG_OP = 'DELETE' THEN
                    RAISE EXCEPTION 'placement catalog questions are auditable and cannot be deleted'
                        USING ERRCODE = 'check_violation';
                END IF;
                -- `media_ref` is a legacy opaque pointer. New authoritative
                -- catalog media must be represented by immutable, checksummed
                -- placement_question_media rows instead.
                IF NEW.media_ref IS NOT NULL THEN
                    RAISE EXCEPTION 'placement questions cannot use legacy media_ref; attach checksummed question media instead'
                        USING ERRCODE = 'check_violation';
                END IF;
                SELECT v.lifecycle_state, s.lifecycle_state, s.component, s.can_auto_score, s.delivery_mode
                  INTO parent_state, section_state, section_component, section_auto, section_delivery
                  FROM placement_sections s
                  JOIN placement_test_versions v ON v.id = s.test_version_id
                 WHERE s.id = NEW.section_id FOR UPDATE OF v;
                IF trim(NEW.code) = '' OR trim(NEW.stem) = ''
                   OR (TG_OP = 'INSERT' AND NEW.lifecycle_state IS DISTINCT FROM 'draft')
                   OR (section_auto AND (NEW.question_type NOT IN ('mcq', 'short_answer') OR NEW.correct_answer IS NULL OR trim(NEW.correct_answer) = ''))
                   OR (NOT section_auto AND (
                        NEW.correct_answer IS NOT NULL
                        OR (section_delivery IS DISTINCT FROM 'physical' AND NEW.question_type NOT IN ('essay', 'speaking'))
                   )) THEN
                    RAISE EXCEPTION 'placement questions require draft matching scoring evidence and server-scored answers only where applicable'
                        USING ERRCODE = 'check_violation';
                END IF;
                IF parent_state IS NULL OR parent_state IS DISTINCT FROM 'draft' OR section_state IS DISTINCT FROM 'draft'
                   OR NEW.component IS DISTINCT FROM section_component THEN
                    RAISE EXCEPTION 'placement question changes require a matching-component draft section in a draft parent version'
                        USING ERRCODE = 'check_violation';
                END IF;
                IF TG_OP = 'UPDATE' THEN
                    IF OLD.lifecycle_state = 'retired' THEN
                        RAISE EXCEPTION 'retired placement questions are immutable catalog history'
                            USING ERRCODE = 'check_violation';
                    END IF;
                    IF OLD.lifecycle_state = 'published' AND (
                        NEW.section_id IS DISTINCT FROM OLD.section_id
                        OR NEW.code IS DISTINCT FROM OLD.code
                        OR NEW.stem IS DISTINCT FROM OLD.stem
                        OR NEW.component IS DISTINCT FROM OLD.component
                        OR NEW.question_type IS DISTINCT FROM OLD.question_type
                        OR NEW.points IS DISTINCT FROM OLD.points
                        OR NEW.options IS DISTINCT FROM OLD.options
                        OR NEW.correct_answer IS DISTINCT FROM OLD.correct_answer
                        OR NEW.media_ref IS DISTINCT FROM OLD.media_ref
                        OR NEW.lifecycle_state IS DISTINCT FROM 'retired'
                    ) THEN
                        RAISE EXCEPTION 'published placement question content is immutable; it may only retire before parent publication'
                            USING ERRCODE = 'check_violation';
                    END IF;
                END IF;
                RETURN NEW;
            END;
            $fn$ LANGUAGE plpgsql;
        SQL);
        DB::statement('CREATE TRIGGER placement_v2_catalog_question_guard_trigger BEFORE INSERT OR UPDATE OR DELETE ON placement_questions FOR EACH ROW EXECUTE FUNCTION placement_v2_catalog_question_guard()');

        DB::statement(<<<'SQL'
            CREATE OR REPLACE FUNCTION placement_v2_catalog_rubric_guard() RETURNS trigger AS $fn$
            DECLARE parent_state text;
            BEGIN
                IF TG_OP = 'DELETE' THEN
                    RAISE EXCEPTION 'placement catalog rubrics are auditable and cannot be deleted'
                        USING ERRCODE = 'check_violation';
                END IF;
                IF trim(NEW.band) = '' OR trim(NEW.description) = ''
                   OR NEW.cefr_ref NOT IN ('A1', 'A2', 'B1', 'B2', 'C1')
                   OR (TG_OP = 'INSERT' AND NEW.lifecycle_state IS DISTINCT FROM 'draft') THEN
                    RAISE EXCEPTION 'placement rubrics require named draft bands with canonical CEFR references'
                        USING ERRCODE = 'check_violation';
                END IF;
                SELECT lifecycle_state INTO parent_state FROM placement_test_versions
                 WHERE id = NEW.test_version_id FOR UPDATE;
                IF parent_state IS NULL OR parent_state IS DISTINCT FROM 'draft' THEN
                    RAISE EXCEPTION 'placement rubric changes require a draft parent test version'
                        USING ERRCODE = 'check_violation';
                END IF;
                IF TG_OP = 'UPDATE' THEN
                    IF OLD.lifecycle_state = 'retired' THEN
                        RAISE EXCEPTION 'retired placement rubrics are immutable catalog history'
                            USING ERRCODE = 'check_violation';
                    END IF;
                    IF OLD.lifecycle_state = 'published' AND (
                        NEW.test_version_id IS DISTINCT FROM OLD.test_version_id
                        OR NEW.component IS DISTINCT FROM OLD.component
                        OR NEW.band IS DISTINCT FROM OLD.band
                        OR NEW.min_score IS DISTINCT FROM OLD.min_score
                        OR NEW.max_score IS DISTINCT FROM OLD.max_score
                        OR NEW.cefr_ref IS DISTINCT FROM OLD.cefr_ref
                        OR NEW.description IS DISTINCT FROM OLD.description
                        OR NEW.lifecycle_state IS DISTINCT FROM 'retired'
                    ) THEN
                        RAISE EXCEPTION 'published placement rubric content is immutable; it may only retire before parent publication'
                            USING ERRCODE = 'check_violation';
                    END IF;
                END IF;
                RETURN NEW;
            END;
            $fn$ LANGUAGE plpgsql;
        SQL);
        DB::statement('CREATE TRIGGER placement_v2_catalog_rubric_guard_trigger BEFORE INSERT OR UPDATE OR DELETE ON placement_rubrics FOR EACH ROW EXECUTE FUNCTION placement_v2_catalog_rubric_guard()');

        DB::statement(<<<'SQL'
            CREATE OR REPLACE FUNCTION placement_v2_catalog_media_guard() RETURNS trigger AS $fn$
            DECLARE parent_state text;
            DECLARE section_state text;
            DECLARE question_state text;
            BEGIN
                IF TG_OP = 'DELETE' THEN
                    RAISE EXCEPTION 'placement question media is auditable and cannot be deleted'
                        USING ERRCODE = 'check_violation';
                END IF;
                IF trim(NEW.uri) = '' OR trim(NEW.media_type) = '' OR trim(NEW.mime_type) = ''
                   OR NEW.sha256 !~ '^[0-9a-f]{64}$'
                   OR (TG_OP = 'INSERT' AND NEW.lifecycle_state IS DISTINCT FROM 'active') THEN
                    RAISE EXCEPTION 'new placement media requires active named content with a lowercase SHA-256 checksum'
                        USING ERRCODE = 'check_violation';
                END IF;
                SELECT v.lifecycle_state, s.lifecycle_state, q.lifecycle_state
                  INTO parent_state, section_state, question_state
                  FROM placement_questions q
                  JOIN placement_sections s ON s.id = q.section_id
                  JOIN placement_test_versions v ON v.id = s.test_version_id
                 WHERE q.id = NEW.question_id FOR UPDATE OF v;
                IF parent_state IS NULL OR parent_state IS DISTINCT FROM 'draft' OR section_state IS DISTINCT FROM 'draft' OR question_state IS DISTINCT FROM 'draft' THEN
                    RAISE EXCEPTION 'placement media changes require a draft question in a draft section/version'
                        USING ERRCODE = 'check_violation';
                END IF;
                IF TG_OP = 'UPDATE' AND (
                    OLD.question_id IS DISTINCT FROM NEW.question_id
                    OR OLD.uri IS DISTINCT FROM NEW.uri
                    OR OLD.media_type IS DISTINCT FROM NEW.media_type
                    OR OLD.sha256 IS DISTINCT FROM NEW.sha256
                    OR OLD.mime_type IS DISTINCT FROM NEW.mime_type
                    OR OLD.lifecycle_state IS DISTINCT FROM 'active'
                    OR NEW.lifecycle_state IS DISTINCT FROM 'retired'
                ) THEN
                    RAISE EXCEPTION 'active placement media content is immutable and may only retire before parent publication'
                        USING ERRCODE = 'check_violation';
                END IF;
                RETURN NEW;
            END;
            $fn$ LANGUAGE plpgsql;
        SQL);
        DB::statement('CREATE TRIGGER placement_v2_catalog_media_guard_trigger BEFORE INSERT OR UPDATE OR DELETE ON placement_question_media FOR EACH ROW EXECUTE FUNCTION placement_v2_catalog_media_guard()');
    }

    public function down(): void
    {
        // V2 creates signed, append-only evidence and deliberately permits a
        // null human scorer for server-calculated results. Dropping its
        // lineage columns or restoring the old NOT NULL would rewrite or make
        // that history invalid, so rollback is allowed only before any V2
        // fact has been written.
        DB::statement(<<<'SQL'
            DO $block$
            BEGIN
                IF EXISTS (SELECT 1 FROM placement_profiles WHERE lineage_version = 'placement-evidence-v2')
                   OR EXISTS (SELECT 1 FROM placement_attempts WHERE lineage_version = 'placement-evidence-v2')
                   OR EXISTS (SELECT 1 FROM placement_recommendations WHERE lineage_version = 'placement-evidence-v2')
                   OR EXISTS (SELECT 1 FROM academic_eligibility_snapshots WHERE snapshot_schema_version = 'academic-context-snapshot-v2')
                   OR EXISTS (SELECT 1 FROM placement_section_results WHERE scoring_method = 'automatic' OR scored_by IS NULL) THEN
                    RAISE EXCEPTION 'placement convergence rollback is blocked after v2 evidence exists; use governed forward remediation rather than rewriting history';
                END IF;
            END;
            $block$;
        SQL);
        foreach ([
            ['placement_v2_catalog_media_guard_trigger', 'placement_question_media'],
            ['placement_v2_catalog_rubric_guard_trigger', 'placement_rubrics'],
            ['placement_v2_version_publish_guard_trigger', 'placement_test_versions'],
            ['placement_v2_version_guard_trigger', 'placement_test_versions'],
            ['placement_v2_catalog_question_guard_trigger', 'placement_questions'],
            ['placement_v2_catalog_section_guard_trigger', 'placement_sections'],
            ['placement_v2_enrollment_evidence_guard_trigger', 'enrollments'],
            ['placement_v2_student_evidence_guard_trigger', 'students'],
            ['placement_v2_applicant_evidence_guard_trigger', 'applicants'],
            ['placement_v2_snapshot_guard_trigger', 'academic_eligibility_snapshots'],
            ['placement_v2_recommendation_guard_trigger', 'placement_recommendations'],
            ['placement_v2_section_result_guard_trigger', 'placement_section_results'],
            ['placement_v2_response_guard_trigger', 'placement_responses'],
            ['placement_v2_attempt_guard_trigger', 'placement_attempts'],
            ['placement_v2_released_profile_snapshot_guard_trigger', 'placement_profiles'],
            ['placement_v2_profile_lifecycle_guard_trigger', 'placement_profiles'],
            ['placement_v2_test_lifecycle_guard_trigger', 'placement_tests'],
            ['placement_v2_test_anchor_guard_trigger', 'placement_tests'],
            ['placement_v2_profile_anchor_guard_trigger', 'placement_profiles'],
        ] as [$trigger, $table]) {
            DB::statement(sprintf('DROP TRIGGER IF EXISTS %s ON %s', $trigger, $table));
        }
        foreach ([
            'placement_v2_catalog_media_guard',
            'placement_v2_catalog_rubric_guard',
            'placement_v2_version_publish_guard',
            'placement_v2_version_guard',
            'placement_v2_catalog_question_guard',
            'placement_v2_catalog_section_guard',
            'placement_v2_enrollment_evidence_guard',
            'placement_v2_student_evidence_guard',
            'placement_v2_applicant_evidence_guard',
            'placement_v2_snapshot_guard',
            'placement_v2_recommendation_guard',
            'placement_v2_section_result_guard',
            'placement_v2_response_guard',
            'placement_v2_attempt_guard',
            'placement_v2_released_profile_snapshot_guard',
            'placement_v2_profile_lifecycle_guard',
            'placement_v2_test_lifecycle_guard',
            'placement_v2_test_anchor_guard',
            'placement_v2_profile_anchor_guard',
        ] as $function) {
            DB::statement(sprintf('DROP FUNCTION IF EXISTS %s()', $function));
        }
        DB::statement('DROP FUNCTION IF EXISTS placement_v2_assert_active_branch(char(36), text)');
        DB::statement('DROP FUNCTION IF EXISTS placement_v2_assert_approved_result_set(char(36))');
        DB::statement('DROP FUNCTION IF EXISTS placement_v2_assert_auto_score_from_responses(char(36), char(36), numeric, numeric)');
        DB::statement('DROP FUNCTION IF EXISTS placement_v2_assert_submittable_response_set(char(36), char(36), text)');
        DB::statement('DROP FUNCTION IF EXISTS placement_v2_assert_complete_result_set(char(36))');
        DB::statement('DROP FUNCTION IF EXISTS placement_v2_assert_recommendation_derivation(char(36), char(36), char(36), text, jsonb)');
        DB::statement('DROP FUNCTION IF EXISTS placement_v2_json_number_equals(jsonb, text, numeric)');
        DB::statement('DROP FUNCTION IF EXISTS placement_v2_cefr_rank(text)');
        DB::statement('DROP FUNCTION IF EXISTS placement_v2_assert_version_publishable(char(36))');
        DB::statement('DROP INDEX IF EXISTS academic_eligibility_snapshots_one_v2_per_profile');
        DB::statement('DROP INDEX IF EXISTS academic_eligibility_snapshots_one_successor');
        DB::statement('DROP INDEX IF EXISTS placement_recommendations_one_v2_per_profile');
        DB::statement('DROP INDEX IF EXISTS placement_attempts_one_v2_decision_attempt_per_profile');
        DB::statement('DROP INDEX IF EXISTS placement_sections_one_order_per_version');
        DB::statement('DROP INDEX IF EXISTS placement_sections_one_component_per_version');
        DB::statement('ALTER TABLE placement_tests DROP CONSTRAINT IF EXISTS placement_tests_v2_component_weights_check');
        DB::statement('DROP FUNCTION IF EXISTS placement_v2_component_weights_valid(jsonb)');
        DB::statement('ALTER TABLE placement_section_results DROP CONSTRAINT IF EXISTS placement_section_results_scoring_method_check');
        DB::statement('ALTER TABLE placement_rubrics DROP CONSTRAINT IF EXISTS placement_rubrics_v2_range_check');
        Schema::table('placement_section_results', function (Blueprint $table): void {
            $table->dropColumn('scoring_method');
        });
        DB::statement('ALTER TABLE placement_section_results ALTER COLUMN scored_by SET NOT NULL');
        Schema::table('placement_recommendations', function (Blueprint $table): void {
            $table->dropForeign(['attempt_id']);
            $table->dropForeign(['program_version_id']);
            $table->dropColumn(['attempt_id', 'program_version_id', 'lineage_version']);
        });
        Schema::table('placement_attempts', function (Blueprint $table): void {
            $table->dropColumn('lineage_version');
        });
        Schema::table('placement_profiles', function (Blueprint $table): void {
            $table->dropForeign(['placement_recommendation_id']);
            $table->dropColumn(['placement_recommendation_id', 'lineage_version']);
        });
    }
};
