<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Schema;

/**
 * Placement Decision System (WP-P).
 *
 * Authority/boundary (docs/architecture/decisions/wp-placement.md):
 *   * Placement is an Academic subsystem; it never creates Person,
 *     Applicant, Student, Enrollment, Payment, Obligation, Message, or
 *     Document. It consumes downstream facts and records evidence/traces only.
 *   * The test bank is version-scoped and immutable once published.
 *   * Attempts, responses, and recommendations are immutable evidence;
 *     corrections are linked appends.
 *   * A placement profile is a person-centric decision object with an
 *     one-open-profile-per-person invariant and a staged review chain.
 *   * Submitted attempts are anti-tampered with a server-computed HMAC.
 *
 * Schema guards mirror the command rules at the database boundary:
 *   - lifecycle CHECKs and NON-NEGATIVE score checks;
 *   - unique per-version section/question codes and per-person live profile;
 *   - origin-branch provenance immutability on operational records;
 *   - submitted-attempt and response immutability;
 *   - recommendation append-only history.
 */
return new class extends Migration
{
    /** The canonical five placement components. */
    private const COMPONENTS = ['grammar', 'reading', 'listening', 'writing', 'speaking'];

    /** Components that can be machine-scored when the section says so. */
    private const AUTOSCORE_TYPES = ['mcq', 'short_answer'];

    public function up(): void
    {
        $this->createTestBank();
        $this->createProfiles();
        $this->extendCrmTrace();
    }

    private function createTestBank(): void
    {
        // 1. Placement test catalog (immutable published versions below).
        Schema::create('placement_tests', function (Blueprint $table): void {
            $table->char('id', 36)->primary();
            $table->string('key')->unique();
            $table->string('name');
            $table->char('program_version_id', 36)->nullable();
            $table->unsignedInteger('total_time_minutes');
            $table->string('scoring_version')->default('rubric-v1');
            $table->jsonb('component_weights');
            $table->string('lifecycle_state');
            $table->char('originating_branch_id', 36)->nullable();
            $table->char('current_home_branch_id', 36)->nullable();
            $table->timestamps();
            $table->foreign('program_version_id')->references('id')->on('program_versions');
            $table->foreign('originating_branch_id')->references('id')->on('branches');
            $table->foreign('current_home_branch_id')->references('id')->on('branches');
        });
        DB::statement("ALTER TABLE placement_tests ADD CONSTRAINT placement_tests_lifecycle_check CHECK (lifecycle_state IN ('draft','published','retired'))");
        DB::statement('ALTER TABLE placement_tests ADD CONSTRAINT placement_tests_time_check CHECK (total_time_minutes > 0)');
        DB::statement(
            "ALTER TABLE placement_tests ADD CONSTRAINT placement_tests_components_check CHECK (jsonb_exists_all(component_weights, array['grammar','reading','listening','writing','speaking']))"
        );
        DB::statement(<<<'SQL'
            CREATE OR REPLACE FUNCTION placement_tests_origin_immutable() RETURNS trigger AS $fn$
            BEGIN
                IF OLD.originating_branch_id IS NOT NULL
                   AND NEW.originating_branch_id IS DISTINCT FROM OLD.originating_branch_id THEN
                    RAISE EXCEPTION 'placement test originating_branch_id is immutable once assigned'
                        USING ERRCODE = 'check_violation';
                END IF;
                RETURN NEW;
            END;
            $fn$ LANGUAGE plpgsql
        SQL);
        DB::statement('CREATE TRIGGER placement_tests_origin_immutable BEFORE UPDATE OF originating_branch_id ON placement_tests FOR EACH ROW EXECUTE FUNCTION placement_tests_origin_immutable()');

        // 2. Immutable published version of a test.
        Schema::create('placement_test_versions', function (Blueprint $table): void {
            $table->char('id', 36)->primary();
            $table->char('placement_test_id', 36);
            $table->unsignedInteger('version_no');
            $table->string('summary');
            $table->string('lifecycle_state');
            $table->timestamp('published_at')->nullable();
            $table->timestamps();
            $table->foreign('placement_test_id')->references('id')->on('placement_tests');
        });
        DB::statement('ALTER TABLE placement_test_versions ADD CONSTRAINT placement_test_versions_test_unique UNIQUE (placement_test_id, version_no)');
        DB::statement("ALTER TABLE placement_test_versions ADD CONSTRAINT placement_test_versions_lifecycle_check CHECK (lifecycle_state IN ('draft','published','retired'))");
        DB::statement(<<<'SQL'
            CREATE OR REPLACE FUNCTION placement_test_versions_publish_guard() RETURNS trigger AS $fn$
            BEGIN
                IF TG_OP = 'DELETE' THEN
                    RAISE EXCEPTION 'placement test versions are auditable and cannot be deleted'
                        USING ERRCODE = 'check_violation';
                END IF;
                IF TG_OP = 'UPDATE' THEN
                    IF OLD.lifecycle_state = 'published' AND (
                        NEW.placement_test_id IS DISTINCT FROM OLD.placement_test_id
                        OR NEW.version_no IS DISTINCT FROM OLD.version_no
                        OR NEW.summary IS DISTINCT FROM OLD.summary
                    ) THEN
                        RAISE EXCEPTION 'published placement versions are immutable'
                            USING ERRCODE = 'check_violation';
                    END IF;
                END IF;
                RETURN NEW;
            END;
            $fn$ LANGUAGE plpgsql
        SQL);
        DB::statement('CREATE TRIGGER placement_test_versions_guard BEFORE UPDATE OR DELETE ON placement_test_versions FOR EACH ROW EXECUTE FUNCTION placement_test_versions_publish_guard()');

        // 3. Sections (one of the five components per section).
        Schema::create('placement_sections', function (Blueprint $table): void {
            $table->char('id', 36)->primary();
            $table->char('test_version_id', 36);
            $table->string('code');
            $table->string('name');
            $table->string('component');
            $table->unsignedInteger('section_order');
            $table->unsignedInteger('time_minutes');
            $table->string('delivery_mode');
            $table->boolean('can_auto_score');
            $table->string('lifecycle_state');
            $table->timestamps();
            $table->foreign('test_version_id')->references('id')->on('placement_test_versions');
        });
        DB::statement('ALTER TABLE placement_sections ADD CONSTRAINT placement_sections_version_code_unique UNIQUE (test_version_id, code)');
        DB::statement("ALTER TABLE placement_sections ADD CONSTRAINT placement_sections_component_check CHECK (component IN ('".implode("','", self::COMPONENTS)."'))");
        DB::statement("ALTER TABLE placement_sections ADD CONSTRAINT placement_sections_delivery_check CHECK (delivery_mode IN ('digital','physical'))");
        DB::statement("ALTER TABLE placement_sections ADD CONSTRAINT placement_sections_lifecycle_check CHECK (lifecycle_state IN ('draft','published','retired'))");
        DB::statement('ALTER TABLE placement_sections ADD CONSTRAINT placement_sections_time_check CHECK (time_minutes > 0)');

        // 4. Questions.
        Schema::create('placement_questions', function (Blueprint $table): void {
            $table->char('id', 36)->primary();
            $table->char('section_id', 36);
            $table->string('code');
            $table->text('stem');
            $table->string('component');
            $table->string('question_type');
            $table->decimal('points', 6, 2)->default(1);
            $table->jsonb('options')->nullable();
            $table->text('correct_answer')->nullable();
            $table->string('media_ref')->nullable();
            $table->string('lifecycle_state');
            $table->timestamps();
            $table->foreign('section_id')->references('id')->on('placement_sections');
        });
        DB::statement('ALTER TABLE placement_questions ADD CONSTRAINT placement_questions_section_code_unique UNIQUE (section_id, code)');
        DB::statement("ALTER TABLE placement_questions ADD CONSTRAINT placement_questions_item_type_check CHECK (question_type IN ('mcq','short_answer','essay','speaking'))");
        DB::statement("ALTER TABLE placement_questions ADD CONSTRAINT placement_questions_component_check CHECK (component IN ('".implode("','", self::COMPONENTS)."'))");
        DB::statement("ALTER TABLE placement_questions ADD CONSTRAINT placement_questions_lifecycle_check CHECK (lifecycle_state IN ('draft','published','retired'))");
        DB::statement('ALTER TABLE placement_questions ADD CONSTRAINT placement_questions_points_check CHECK (points > 0)');

        // 5. Question media (checksummed, anti-tamper evidence).
        Schema::create('placement_question_media', function (Blueprint $table): void {
            $table->char('id', 36)->primary();
            $table->char('question_id', 36);
            $table->string('uri');
            $table->string('media_type');
            $table->char('sha256', 64);
            $table->string('mime_type');
            $table->string('lifecycle_state');
            $table->timestamps();
            $table->foreign('question_id')->references('id')->on('placement_questions');
        });
        DB::statement('ALTER TABLE placement_question_media ADD CONSTRAINT placement_question_media_question_uri_unique UNIQUE (question_id, uri)');
        DB::statement("ALTER TABLE placement_question_media ADD CONSTRAINT placement_question_media_lifecycle_check CHECK (lifecycle_state IN ('active','retired'))");
        DB::statement('ALTER TABLE placement_question_media ADD CONSTRAINT placement_question_media_sha_check CHECK (sha256 ~ \'^[0-9a-f]{64}$\')');

        // 6. Rubrics (score range -> CEFR band for one component/version).
        Schema::create('placement_rubrics', function (Blueprint $table): void {
            $table->char('id', 36)->primary();
            $table->char('test_version_id', 36);
            $table->string('component');
            $table->string('band');
            $table->decimal('min_score', 6, 2);
            $table->decimal('max_score', 6, 2);
            $table->string('cefr_ref');
            $table->text('description');
            $table->string('lifecycle_state');
            $table->timestamps();
            $table->foreign('test_version_id')->references('id')->on('placement_test_versions');
        });
        DB::statement('ALTER TABLE placement_rubrics ADD CONSTRAINT placement_rubrics_version_component_band_unique UNIQUE (test_version_id, component, band)');
        DB::statement("ALTER TABLE placement_rubrics ADD CONSTRAINT placement_rubrics_component_check CHECK (component IN ('".implode("','", self::COMPONENTS)."'))");
        DB::statement("ALTER TABLE placement_rubrics ADD CONSTRAINT placement_rubrics_lifecycle_check CHECK (lifecycle_state IN ('draft','published','retired'))");
        DB::statement('ALTER TABLE placement_rubrics ADD CONSTRAINT placement_rubrics_range_check CHECK (min_score <= max_score)');
    }

    private function createProfiles(): void
    {
        $openProfileStates = "('draft','scored','recommended','reviewed','approved','released')";

        Schema::create('placement_profiles', function (Blueprint $table): void {
            $table->char('id', 36)->primary();
            $table->char('person_id', 36);
            $table->char('visitor_id', 36)->nullable();
            $table->char('program_version_id', 36)->nullable();
            $table->char('recommended_level_id', 36)->nullable();
            $table->char('recommended_offering_id', 36)->nullable();
            $table->char('recommended_class_id', 36)->nullable();
            $table->string('overall_cefr_ref')->nullable();
            $table->string('lifecycle_state');
            $table->char('originating_branch_id', 36)->nullable();
            $table->char('current_home_branch_id', 36)->nullable();
            $table->char('reviewed_by', 36)->nullable();
            $table->char('approved_by', 36)->nullable();
            $table->char('released_by', 36)->nullable();
            $table->char('created_by', 36);
            $table->timestamps();
            $table->foreign('person_id')->references('id')->on('people');
            $table->foreign('visitor_id')->references('id')->on('visitors');
            $table->foreign('program_version_id')->references('id')->on('program_versions');
            $table->foreign('recommended_level_id')->references('id')->on('program_version_levels');
            $table->foreign('recommended_offering_id')->references('id')->on('offerings');
            $table->foreign('recommended_class_id')->references('id')->on('classes');
            $table->foreign('originating_branch_id')->references('id')->on('branches');
            $table->foreign('current_home_branch_id')->references('id')->on('branches');
            $table->foreign('reviewed_by')->references('id')->on('people');
            $table->foreign('approved_by')->references('id')->on('people');
            $table->foreign('released_by')->references('id')->on('people');
            $table->foreign('created_by')->references('id')->on('people');
        });
        DB::statement("ALTER TABLE placement_profiles ADD CONSTRAINT placement_profiles_lifecycle_check CHECK (lifecycle_state IN ('draft','scored','recommended','reviewed','approved','released','superseded','retired'))");
        DB::statement(sprintf('CREATE UNIQUE INDEX placement_profiles_one_open_per_person ON placement_profiles (person_id) WHERE lifecycle_state IN %s', $openProfileStates));
        DB::statement(<<<'SQL'
            CREATE OR REPLACE FUNCTION placement_profiles_origin_immutable() RETURNS trigger AS $fn$
            BEGIN
                IF OLD.originating_branch_id IS NOT NULL
                   AND NEW.originating_branch_id IS DISTINCT FROM OLD.originating_branch_id THEN
                    RAISE EXCEPTION 'placement profile originating_branch_id is immutable once assigned'
                        USING ERRCODE = 'check_violation';
                END IF;
                RETURN NEW;
            END;
            $fn$ LANGUAGE plpgsql
        SQL);
        DB::statement('CREATE TRIGGER placement_profiles_origin_immutable BEFORE UPDATE OF originating_branch_id ON placement_profiles FOR EACH ROW EXECUTE FUNCTION placement_profiles_origin_immutable()');

        Schema::create('placement_attempts', function (Blueprint $table): void {
            $table->char('id', 36)->primary();
            $table->char('profile_id', 36);
            $table->char('test_version_id', 36);
            $table->string('delivery_mode');
            $table->unsignedInteger('attempt_no');
            $table->string('status');
            $table->timestamp('started_at')->nullable();
            $table->timestamp('ended_at')->nullable();
            $table->unsignedInteger('duration_seconds')->nullable();
            $table->text('evidence_ref')->nullable();
            $table->char('anti_tamper_hmac', 64)->nullable();
            $table->boolean('tamper_flagged')->default(false);
            $table->text('tamper_reason')->nullable();
            $table->char('proctor_person_id', 36)->nullable();
            $table->char('originating_branch_id', 36)->nullable();
            $table->char('current_home_branch_id', 36)->nullable();
            $table->string('correlation_id');
            $table->timestamps();
            $table->foreign('profile_id')->references('id')->on('placement_profiles');
            $table->foreign('test_version_id')->references('id')->on('placement_test_versions');
            $table->foreign('proctor_person_id')->references('id')->on('people');
            $table->foreign('originating_branch_id')->references('id')->on('branches');
            $table->foreign('current_home_branch_id')->references('id')->on('branches');
        });
        DB::statement('ALTER TABLE placement_attempts ADD CONSTRAINT placement_attempts_profile_attempt_unique UNIQUE (profile_id, attempt_no)');
        DB::statement("ALTER TABLE placement_attempts ADD CONSTRAINT placement_attempts_delivery_check CHECK (delivery_mode IN ('digital','physical'))");
        DB::statement("ALTER TABLE placement_attempts ADD CONSTRAINT placement_attempts_status_check CHECK (status IN ('scheduled','in_progress','submitted','timed_out','cancelled'))");
        DB::statement('ALTER TABLE placement_attempts ADD CONSTRAINT placement_attempts_duration_check CHECK (duration_seconds IS NULL OR duration_seconds >= 0)');
        DB::statement(<<<'SQL'
            CREATE OR REPLACE FUNCTION placement_attempts_evidence_immutable() RETURNS trigger AS $fn$
            BEGIN
                IF TG_OP = 'DELETE' THEN
                    IF OLD.status IN ('submitted','timed_out') THEN
                        RAISE EXCEPTION 'submitted placement attempts are immutable evidence'
                            USING ERRCODE = 'check_violation';
                    END IF;
                    RETURN OLD;
                END IF;
                IF OLD.status IN ('submitted','timed_out')
                   AND (NEW.status IS DISTINCT FROM OLD.status
                        OR NEW.evidence_ref IS DISTINCT FROM OLD.evidence_ref
                        OR NEW.anti_tamper_hmac IS DISTINCT FROM OLD.anti_tamper_hmac) THEN
                    RAISE EXCEPTION 'submitted placement attempts are immutable evidence'
                        USING ERRCODE = 'check_violation';
                END IF;
                RETURN NEW;
            END;
            $fn$ LANGUAGE plpgsql
        SQL);
        DB::statement('CREATE TRIGGER placement_attempts_evidence_immutable BEFORE UPDATE OR DELETE ON placement_attempts FOR EACH ROW EXECUTE FUNCTION placement_attempts_evidence_immutable()');

        // Raw answers are immutable evidence once written.
        Schema::create('placement_responses', function (Blueprint $table): void {
            $table->char('id', 36)->primary();
            $table->char('attempt_id', 36);
            $table->char('question_id', 36);
            $table->text('response_value');
            $table->boolean('tamper_flagged')->default(false);
            $table->char('evidence_sha256', 64)->nullable();
            $table->timestamps();
            $table->foreign('attempt_id')->references('id')->on('placement_attempts');
            $table->foreign('question_id')->references('id')->on('placement_questions');
        });
        DB::statement('ALTER TABLE placement_responses ADD CONSTRAINT placement_responses_attempt_question_unique UNIQUE (attempt_id, question_id)');
        DB::statement('ALTER TABLE placement_responses ADD CONSTRAINT placement_responses_evidence_sha_check CHECK (evidence_sha256 IS NULL OR evidence_sha256 ~ \'^[0-9a-f]{64}$\')');
        DB::statement(<<<'SQL'
            CREATE OR REPLACE FUNCTION placement_responses_append_only() RETURNS trigger AS $fn$
            BEGIN
                RAISE EXCEPTION 'placement responses are immutable evidence; a correction is a new response'
                    USING ERRCODE = 'check_violation';
            END;
            $fn$ LANGUAGE plpgsql
        SQL);
        DB::statement('CREATE TRIGGER placement_responses_append_only BEFORE UPDATE OR DELETE ON placement_responses FOR EACH ROW EXECUTE FUNCTION placement_responses_append_only()');

        Schema::create('placement_section_results', function (Blueprint $table): void {
            $table->char('id', 36)->primary();
            $table->char('attempt_id', 36);
            $table->char('section_id', 36);
            $table->string('component');
            $table->decimal('raw_score', 6, 2)->nullable();
            $table->decimal('adjusted_score', 6, 2)->nullable();
            $table->decimal('weighted_score', 6, 2)->nullable();
            $table->char('rubric_id', 36)->nullable();
            $table->string('cefr_ref')->nullable();
            $table->string('lifecycle_state');
            $table->char('scored_by', 36);
            $table->char('moderated_by', 36)->nullable();
            $table->char('approved_by', 36)->nullable();
            $table->text('rationale')->nullable();
            $table->timestamps();
            $table->foreign('attempt_id')->references('id')->on('placement_attempts');
            $table->foreign('section_id')->references('id')->on('placement_sections');
            $table->foreign('rubric_id')->references('id')->on('placement_rubrics');
            $table->foreign('scored_by')->references('id')->on('people');
        });
        DB::statement('ALTER TABLE placement_section_results ADD CONSTRAINT placement_section_results_attempt_section_unique UNIQUE (attempt_id, section_id)');
        DB::statement("ALTER TABLE placement_section_results ADD CONSTRAINT placement_section_results_component_check CHECK (component IN ('".implode("','", self::COMPONENTS)."'))");
        DB::statement("ALTER TABLE placement_section_results ADD CONSTRAINT placement_section_results_lifecycle_check CHECK (lifecycle_state IN ('scored','moderated','approved'))");
        DB::statement('ALTER TABLE placement_section_results ADD CONSTRAINT placement_section_results_score_check CHECK (raw_score IS NULL OR raw_score >= 0)');
        DB::statement('ALTER TABLE placement_section_results ADD CONSTRAINT placement_section_results_adjusted_check CHECK (adjusted_score IS NULL OR adjusted_score >= 0)');
        DB::statement('ALTER TABLE placement_section_results ADD CONSTRAINT placement_section_results_weighted_check CHECK (weighted_score IS NULL OR weighted_score >= 0)');
        DB::statement('ALTER TABLE placement_section_results ADD CONSTRAINT placement_section_results_score_note_check CHECK (raw_score IS NOT NULL OR rationale IS NOT NULL)');
        DB::statement(<<<'SQL'
            CREATE OR REPLACE FUNCTION placement_section_results_approved_immutable() RETURNS trigger AS $fn$
            BEGIN
                IF TG_OP = 'DELETE' THEN
                    RAISE EXCEPTION 'placement section results are auditable facts and cannot be deleted'
                        USING ERRCODE = 'check_violation';
                END IF;
                IF OLD.lifecycle_state = 'approved' AND (
                    NEW.attempt_id IS DISTINCT FROM OLD.attempt_id
                    OR NEW.section_id IS DISTINCT FROM OLD.section_id
                    OR NEW.raw_score IS DISTINCT FROM OLD.raw_score
                    OR NEW.adjusted_score IS DISTINCT FROM OLD.adjusted_score
                    OR NEW.weighted_score IS DISTINCT FROM OLD.weighted_score
                    OR NEW.rubric_id IS DISTINCT FROM OLD.rubric_id
                    OR NEW.cefr_ref IS DISTINCT FROM OLD.cefr_ref
                ) THEN
                    RAISE EXCEPTION 'approved placement section results are immutable'
                        USING ERRCODE = 'check_violation';
                END IF;
                RETURN NEW;
            END;
            $fn$ LANGUAGE plpgsql
        SQL);
        DB::statement('CREATE TRIGGER placement_section_results_guard BEFORE UPDATE OR DELETE ON placement_section_results FOR EACH ROW EXECUTE FUNCTION placement_section_results_approved_immutable()');

        // Immutable recommendation history.
        Schema::create('placement_recommendations', function (Blueprint $table): void {
            $table->char('id', 36)->primary();
            $table->char('profile_id', 36);
            $table->char('recommended_level_id', 36);
            $table->char('recommended_class_id', 36)->nullable();
            $table->char('recommended_offering_id', 36)->nullable();
            $table->text('rationale');
            $table->string('model_version');
            $table->jsonb('score_snapshot');
            $table->char('recommended_by', 36);
            $table->timestamps();
            $table->foreign('profile_id')->references('id')->on('placement_profiles');
            $table->foreign('recommended_level_id')->references('id')->on('program_version_levels');
            $table->foreign('recommended_class_id')->references('id')->on('classes');
            $table->foreign('recommended_offering_id')->references('id')->on('offerings');
            $table->foreign('recommended_by')->references('id')->on('people');
        });
        DB::statement(<<<'SQL'
            CREATE OR REPLACE FUNCTION placement_recommendations_append_only() RETURNS trigger AS $fn$
            BEGIN
                RAISE EXCEPTION 'placement recommendations are immutable history'
                    USING ERRCODE = 'check_violation';
            END;
            $fn$ LANGUAGE plpgsql
        SQL);
        DB::statement('CREATE TRIGGER placement_recommendations_append_only BEFORE UPDATE OR DELETE ON placement_recommendations FOR EACH ROW EXECUTE FUNCTION placement_recommendations_append_only()');
    }

    private function extendCrmTrace(): void
    {
        DB::statement('ALTER TABLE visitor_interactions ADD COLUMN placement_attempt_id CHAR(36) NULL');
        DB::statement('ALTER TABLE visitor_interactions ADD CONSTRAINT visitor_interactions_placement_attempt_foreign FOREIGN KEY (placement_attempt_id) REFERENCES placement_attempts (id)');
        DB::statement('ALTER TABLE visitor_interactions DROP CONSTRAINT IF EXISTS visitor_interactions_type_check');
        DB::statement("ALTER TABLE visitor_interactions ADD CONSTRAINT visitor_interactions_type_check CHECK (type IN ('call','whatsapp','email','sms','visit','meeting','form_submission','document','note','other','payment','assessment','placement'))");
    }

    public function down(): void
    {
        DB::statement('DROP TRIGGER IF EXISTS placement_recommendations_append_only ON placement_recommendations');
        DB::statement('DROP FUNCTION IF EXISTS placement_recommendations_append_only()');
        DB::statement('DROP TRIGGER IF EXISTS placement_section_results_guard ON placement_section_results');
        DB::statement('DROP FUNCTION IF EXISTS placement_section_results_approved_immutable()');
        DB::statement('DROP TRIGGER IF EXISTS placement_responses_append_only ON placement_responses');
        DB::statement('DROP FUNCTION IF EXISTS placement_responses_append_only()');
        DB::statement('DROP TRIGGER IF EXISTS placement_attempts_evidence_immutable ON placement_attempts');
        DB::statement('DROP FUNCTION IF EXISTS placement_attempts_evidence_immutable()');
        DB::statement('DROP TRIGGER IF EXISTS placement_profiles_origin_immutable ON placement_profiles');
        DB::statement('DROP FUNCTION IF EXISTS placement_profiles_origin_immutable()');
        DB::statement('DROP TRIGGER IF EXISTS placement_tests_origin_immutable ON placement_tests');
        DB::statement('DROP FUNCTION IF EXISTS placement_tests_origin_immutable()');
        DB::statement('DROP TRIGGER IF EXISTS placement_test_versions_guard ON placement_test_versions');
        DB::statement('DROP FUNCTION IF EXISTS placement_test_versions_publish_guard()');

        DB::statement('ALTER TABLE visitor_interactions DROP CONSTRAINT IF EXISTS visitor_interactions_type_check');
        DB::statement('ALTER TABLE visitor_interactions DROP CONSTRAINT IF EXISTS visitor_interactions_placement_attempt_foreign');
        DB::statement('ALTER TABLE visitor_interactions DROP COLUMN IF EXISTS placement_attempt_id');

        Schema::dropIfExists('placement_recommendations');
        Schema::dropIfExists('placement_section_results');
        Schema::dropIfExists('placement_responses');
        Schema::dropIfExists('placement_attempts');
        Schema::dropIfExists('placement_profiles');
        Schema::dropIfExists('placement_rubrics');
        Schema::dropIfExists('placement_question_media');
        Schema::dropIfExists('placement_questions');
        Schema::dropIfExists('placement_sections');
        Schema::dropIfExists('placement_test_versions');
        Schema::dropIfExists('placement_tests');
    }
};
