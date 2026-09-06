<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Schema;

/**
 * AC4 level-aware academic progression, prerequisites, repeat/advance rules,
 * immutable per-level history, and the offering-linked finance packaging
 * reference (ADR-018).
 *
 * - level_prerequisites: active/retired pair of levels within one program
 *   version; no self edge, no active cycle (schema + trigger).
 * - level_progression_rules: optional minimum passing score / max repeats per
 *   level (absent numeric rule is never an invented boundary).
 * - progression_decisions become level-aware (from/to level, repeat count,
 *   basis, optional assessment result) when their class targets a level.
 * - level_progress_facts: immutable history row per approved level-aware
 *   decision.
 * - obligations.offering_id: Finance-owned academic packaging reference.
 */
return new class extends Migration
{
    public function up(): void
    {
        Schema::create('level_prerequisites', function (Blueprint $table): void {
            $table->char('id', 36)->primary();
            $table->char('target_level_id', 36);
            $table->char('required_level_id', 36);
            $table->string('lifecycle_state');
            $table->char('defined_by', 36);
            $table->timestamps();
            $table->foreign('target_level_id')->references('id')->on('program_version_levels');
            $table->foreign('required_level_id')->references('id')->on('program_version_levels');
        });
        DB::statement("ALTER TABLE level_prerequisites ADD CONSTRAINT level_prerequisites_lifecycle_check CHECK (lifecycle_state IN ('active','retired'))");
        DB::statement('ALTER TABLE level_prerequisites ADD CONSTRAINT level_prerequisites_not_self_check CHECK (target_level_id <> required_level_id)');
        DB::statement('CREATE UNIQUE INDEX level_prerequisites_active_pair ON level_prerequisites (target_level_id, required_level_id) WHERE lifecycle_state = \'active\'');

        DB::statement(<<<'SQL'
            CREATE OR REPLACE FUNCTION level_prerequisites_guard() RETURNS trigger AS $fn$
            DECLARE
                target_version char(36);
                required_version char(36);
                cycle_found boolean;
            BEGIN
                SELECT program_version_id INTO target_version FROM program_version_levels WHERE id = NEW.target_level_id;
                SELECT program_version_id INTO required_version FROM program_version_levels WHERE id = NEW.required_level_id;
                IF target_version IS NULL OR required_version IS NULL THEN
                    RETURN NEW; -- foreign key reports a missing level
                END IF;
                IF target_version <> required_version THEN
                    RAISE EXCEPTION 'level prerequisites must belong to the same program version'
                        USING ERRCODE = 'check_violation';
                END IF;

                IF NEW.lifecycle_state = 'active' THEN
                    EXECUTE '
                        SELECT EXISTS (
                            WITH RECURSIVE chain AS (
                                SELECT required_level_id AS node
                                  FROM level_prerequisites
                                 WHERE target_level_id = $1
                                   AND lifecycle_state = ''active''
                                UNION
                                SELECT lp.required_level_id
                                  FROM level_prerequisites lp
                                  JOIN chain ON lp.target_level_id = chain.node
                                 WHERE lp.lifecycle_state = ''active''
                            )
                            SELECT 1 FROM chain WHERE node = $2
                        )
                    ' INTO cycle_found USING NEW.required_level_id, NEW.target_level_id;
                    IF cycle_found THEN
                        RAISE EXCEPTION 'an active level prerequisite cycle is not allowed'
                            USING ERRCODE = 'check_violation';
                    END IF;
                END IF;
                RETURN NEW;
            END;
            $fn$ LANGUAGE plpgsql
            SQL);
        DB::statement('CREATE TRIGGER level_prerequisites_guard_trigger BEFORE INSERT OR UPDATE ON level_prerequisites FOR EACH ROW EXECUTE FUNCTION level_prerequisites_guard()');

        Schema::create('level_progression_rules', function (Blueprint $table): void {
            $table->char('id', 36)->primary();
            $table->char('program_version_level_id', 36);
            $table->decimal('minimum_passing_score', 5, 2)->nullable();
            $table->integer('max_repeats')->nullable();
            $table->string('lifecycle_state');
            $table->char('defined_by', 36);
            $table->timestamps();
            $table->foreign('program_version_level_id')->references('id')->on('program_version_levels');
        });
        DB::statement("ALTER TABLE level_progression_rules ADD CONSTRAINT level_progression_rules_lifecycle_check CHECK (lifecycle_state IN ('active','retired'))");
        DB::statement('ALTER TABLE level_progression_rules ADD CONSTRAINT level_progression_rules_score_check CHECK (minimum_passing_score IS NULL OR minimum_passing_score >= 0)');
        DB::statement('ALTER TABLE level_progression_rules ADD CONSTRAINT level_progression_rules_repeats_check CHECK (max_repeats IS NULL OR max_repeats >= 1)');
        DB::statement('CREATE UNIQUE INDEX level_progression_rules_active_level ON level_progression_rules (program_version_level_id) WHERE lifecycle_state = \'active\'');

        Schema::table('progression_decisions', function (Blueprint $table): void {
            $table->char('from_level_id', 36)->nullable();
            $table->char('to_level_id', 36)->nullable();
            $table->char('assessment_result_id', 36)->nullable();
            $table->string('basis')->nullable();
            $table->integer('repeat_count')->nullable();
            $table->foreign('from_level_id')->references('id')->on('program_version_levels');
            $table->foreign('to_level_id')->references('id')->on('program_version_levels');
            $table->foreign('assessment_result_id')->references('id')->on('assessment_results');
        });

        DB::statement(<<<'SQL'
            CREATE OR REPLACE FUNCTION progression_decisions_level_guard() RETURNS trigger AS $fn$
            DECLARE
                class_version char(36);
                class_level char(36);
                from_version char(36);
                to_version char(36);
                from_ordinal integer;
                to_ordinal integer;
            BEGIN
                IF NEW.from_level_id IS NULL AND NEW.to_level_id IS NULL THEN
                    RETURN NEW; -- legacy class-scoped path
                END IF;
                IF NEW.from_level_id IS NULL OR NEW.to_level_id IS NULL THEN
                    RAISE EXCEPTION 'a level-aware progression requires both from and to levels'
                        USING ERRCODE = 'check_violation';
                END IF;

                SELECT program_version_id, program_version_level_id INTO class_version, class_level
                  FROM classes WHERE id = NEW.class_id;
                SELECT program_version_id, ordinal INTO from_version, from_ordinal
                  FROM program_version_levels WHERE id = NEW.from_level_id;
                SELECT program_version_id, ordinal INTO to_version, to_ordinal
                  FROM program_version_levels WHERE id = NEW.to_level_id;

                IF class_level IS DISTINCT FROM NEW.from_level_id THEN
                    RAISE EXCEPTION 'the from level must be the class level'
                        USING ERRCODE = 'check_violation';
                END IF;
                IF class_version IS DISTINCT FROM from_version OR from_version IS DISTINCT FROM to_version THEN
                    RAISE EXCEPTION 'progression levels must belong to the class program version'
                        USING ERRCODE = 'check_violation';
                END IF;
                IF NEW.outcome = 'advance' AND to_ordinal <> from_ordinal + 1 THEN
                    RAISE EXCEPTION 'an advance must target the next level ordinal'
                        USING ERRCODE = 'check_violation';
                END IF;
                IF NEW.outcome = 'repeat' AND NEW.to_level_id <> NEW.from_level_id THEN
                    RAISE EXCEPTION 'a repeat must target the current level'
                        USING ERRCODE = 'check_violation';
                END IF;
                IF NEW.basis IS NULL OR NEW.basis = '' THEN
                    RAISE EXCEPTION 'a level-aware progression requires its basis'
                        USING ERRCODE = 'check_violation';
                END IF;
                RETURN NEW;
            END;
            $fn$ LANGUAGE plpgsql
            SQL);
        DB::statement('CREATE TRIGGER progression_decisions_level_guard_trigger BEFORE INSERT OR UPDATE ON progression_decisions FOR EACH ROW EXECUTE FUNCTION progression_decisions_level_guard()');

        Schema::create('level_progress_facts', function (Blueprint $table): void {
            $table->char('id', 36)->primary();
            $table->char('student_id', 36);
            $table->char('program_version_id', 36);
            $table->char('level_id', 36);
            $table->char('to_level_id', 36)->nullable();
            $table->char('class_id', 36);
            $table->char('offering_id', 36)->nullable();
            $table->char('academic_period_id', 36);
            $table->char('decision_id', 36);
            $table->char('assessment_result_id', 36)->nullable();
            $table->string('outcome');
            $table->integer('repeat_count');
            $table->timestamp('achieved_at');
            $table->timestamps();
            $table->foreign('student_id')->references('id')->on('students');
            $table->foreign('program_version_id')->references('id')->on('program_versions');
            $table->foreign('level_id')->references('id')->on('program_version_levels');
            $table->foreign('to_level_id')->references('id')->on('program_version_levels');
            $table->foreign('class_id')->references('id')->on('classes');
            $table->foreign('offering_id')->references('id')->on('offerings');
            $table->foreign('academic_period_id')->references('id')->on('academic_periods');
            $table->foreign('decision_id')->references('id')->on('progression_decisions');
            $table->foreign('assessment_result_id')->references('id')->on('assessment_results');
            $table->unique('decision_id');
        });
        DB::statement("ALTER TABLE level_progress_facts ADD CONSTRAINT level_progress_facts_outcome_check CHECK (outcome IN ('advance','repeat'))");
        DB::statement('ALTER TABLE level_progress_facts ADD CONSTRAINT level_progress_facts_repeat_count_check CHECK (repeat_count >= 0)');
        DB::statement(<<<'SQL'
            CREATE OR REPLACE FUNCTION level_progress_facts_immutable() RETURNS trigger AS $fn$
            BEGIN
                RAISE EXCEPTION 'level progress facts are immutable academic history';
            END;
            $fn$ LANGUAGE plpgsql
            SQL);
        DB::statement('CREATE TRIGGER level_progress_facts_immutable_trigger BEFORE UPDATE OR DELETE ON level_progress_facts FOR EACH ROW EXECUTE FUNCTION level_progress_facts_immutable()');

        Schema::table('obligations', function (Blueprint $table): void {
            $table->char('offering_id', 36)->nullable();
            $table->foreign('offering_id')->references('id')->on('offerings');
        });
    }

    public function down(): void
    {
        Schema::table('obligations', function (Blueprint $table): void {
            $table->dropForeign(['offering_id']);
            $table->dropColumn('offering_id');
        });

        DB::statement('DROP TRIGGER IF EXISTS level_progress_facts_immutable_trigger ON level_progress_facts');
        DB::statement('DROP FUNCTION IF EXISTS level_progress_facts_immutable()');
        Schema::dropIfExists('level_progress_facts');

        DB::statement('DROP TRIGGER IF EXISTS progression_decisions_level_guard_trigger ON progression_decisions');
        DB::statement('DROP FUNCTION IF EXISTS progression_decisions_level_guard()');

        Schema::table('progression_decisions', function (Blueprint $table): void {
            $table->dropForeign(['assessment_result_id']);
            $table->dropForeign(['to_level_id']);
            $table->dropForeign(['from_level_id']);
            $table->dropColumn(['from_level_id', 'to_level_id', 'assessment_result_id', 'basis', 'repeat_count']);
        });

        DB::statement('DROP TRIGGER IF EXISTS level_prerequisites_guard_trigger ON level_prerequisites');
        DB::statement('DROP FUNCTION IF EXISTS level_prerequisites_guard()');
        Schema::dropIfExists('level_progression_rules');
        Schema::dropIfExists('level_prerequisites');
    }
};
