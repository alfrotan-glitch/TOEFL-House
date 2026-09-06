<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Schema;

/**
 * WP-2 S1 (WP2-DEC-05): typed, versioned, audited governed_configs registry.
 *
 * Two tables:
 *  - governed_config_definitions : the governance boundary. A governed
 *    configuration key exists only after it is explicitly ratified here with a
 *    fixed config_type. This is the registry's anti-drift rule: a value becomes
 *    governed only when an approved definition says so — arbitrary keys/types
 *    are never silently accepted. Definitions are append-only and immutable.
 *  - governed_configs : append-mostly effective versions of a value for a
 *    ratified key. Value is a typed JSONB envelope {"v": <scalar>} whose shape
 *    and constraints must match the ratified config_type (enforced in a DB
 *    trigger behind the domain validation). Exactly one OPEN version may exist
 *    per key (partial unique index); effective windows for a key never overlap
 *    (GiST exclusion constraint over the half-open [effective_from, effective_to)
 *    range with NULL = unbounded) — so at most one version governs any day and
 *    there is never ambiguous authority. History is immutable: after a version
 *    is retired (active -> ended) no column may change and it may not be
 *    deleted; an OPEN version may only be retired, never edited.
 *
 * Storage of governed values uses a canonical Gregorian date only; this
 * migration introduces no calendar conversion (F4 remains frozen).
 */
return new class extends Migration
{
    public function up(): void
    {
        DB::statement('CREATE EXTENSION IF NOT EXISTS btree_gist');

        Schema::create('governed_config_definitions', function (Blueprint $table): void {
            $table->char('id', 36)->primary();
            $table->string('config_key')->unique();
            $table->string('config_type');
            $table->string('title');
            $table->char('ratified_by', 36);
            $table->timestamps();
            $table->foreign('ratified_by')->references('id')->on('people');
        });

        Schema::create('governed_configs', function (Blueprint $table): void {
            $table->char('id', 36)->primary();
            $table->string('config_key');
            $table->string('config_type');
            $table->integer('version_no');
            $table->jsonb('value');
            $table->date('effective_from');
            $table->date('effective_to')->nullable();
            $table->char('supersedes_id', 36)->nullable();
            $table->string('lifecycle_state');
            $table->string('review_cycle')->nullable();
            $table->char('approved_by', 36);
            $table->timestamps();

            $table->foreign('config_key')->references('config_key')->on('governed_config_definitions');
            $table->foreign('approved_by')->references('id')->on('people');
            $table->unique(['config_key', 'version_no']);
            $table->unique(['config_key', 'effective_from']);
        });

        // Self-referential lineage is added after the table exists so its
        // primary key is guaranteed present for the foreign key.
        Schema::table('governed_configs', function (Blueprint $table): void {
            $table->foreign('supersedes_id')->references('id')->on('governed_configs');
        });

        // No two effective windows of the same config_key may overlap. A NULL
        // effective_to is unbounded, so it is widened to date 'infinity'. The
        // half-open range '[)' makes adjacent [a,b) and [b,c) non-overlapping.
        DB::statement(<<<'SQL'
            ALTER TABLE governed_configs ADD CONSTRAINT governed_configs_no_overlap
            EXCLUDE USING gist (
                config_key WITH =,
                daterange(effective_from, COALESCE(effective_to, 'infinity'::date), '[)') WITH &&
            )
        SQL);

        // Invariants enforced as table checks (in addition to the write guard).
        DB::statement('ALTER TABLE governed_configs ADD CONSTRAINT governed_configs_version_positive CHECK (version_no >= 1)');
        DB::statement("ALTER TABLE governed_configs ADD CONSTRAINT governed_configs_lifecycle_known CHECK (lifecycle_state IN ('active','ended'))");
        DB::statement(<<<'SQL'
            ALTER TABLE governed_configs ADD CONSTRAINT governed_configs_state_window_consistent CHECK (
                (lifecycle_state = 'active' AND effective_to IS NULL)
                OR (lifecycle_state = 'ended' AND effective_to IS NOT NULL)
            )
        SQL);
        DB::statement('ALTER TABLE governed_configs ADD CONSTRAINT governed_configs_window_not_inverted CHECK (effective_to IS NULL OR effective_to >= effective_from)');

        // At most one OPEN version per config key: exactly one authoritative
        // value runs to the present/future for a governed configuration.
        DB::statement(<<<'SQL'
            CREATE UNIQUE INDEX governed_configs_one_open_per_key
                ON governed_configs (config_key) WHERE lifecycle_state = 'active'
        SQL);

        DB::statement(<<<'SQL'
            CREATE OR REPLACE FUNCTION governed_config_definitions_append_only() RETURNS trigger AS $fn$
            BEGIN
                RAISE EXCEPTION 'governed_config_definitions is append-only (a key, once ratified, is immutable)'
                    USING ERRCODE = 'check_violation';
            END;
            $fn$ LANGUAGE plpgsql
        SQL);
        DB::statement('CREATE TRIGGER governed_config_definitions_append_only_trigger BEFORE UPDATE OR DELETE ON governed_config_definitions FOR EACH ROW EXECUTE FUNCTION governed_config_definitions_append_only()');

        DB::statement(<<<'SQL'
            CREATE OR REPLACE FUNCTION governed_configs_write_guard() RETURNS trigger AS $fn$
            DECLARE
                declared_type text;
                v jsonb;
                scalar_text text;
                scalar_num numeric;
                max_version integer;
            BEGIN
                SELECT config_type INTO declared_type
                  FROM governed_config_definitions WHERE config_key = NEW.config_key;
                IF declared_type IS NULL THEN
                    RAISE EXCEPTION 'governed config key % has no ratified definition', NEW.config_key
                        USING ERRCODE = 'check_violation';
                END IF;
                IF NEW.config_type <> declared_type THEN
                    RAISE EXCEPTION 'governed config % type % does not match its ratified type %',
                        NEW.config_key, NEW.config_type, declared_type USING ERRCODE = 'check_violation';
                END IF;

                IF NEW.effective_to IS NOT NULL AND NEW.effective_to < NEW.effective_from THEN
                    RAISE EXCEPTION 'governed config effective window is inverted'
                        USING ERRCODE = 'check_violation';
                END IF;

                v := NEW.value;
                IF jsonb_typeof(v) IS DISTINCT FROM 'object'
                   OR NOT jsonb_exists(v, 'v')
                   OR jsonb_typeof(v -> 'v') IS NULL THEN
                    RAISE EXCEPTION 'governed config value must be an envelope object with a member "v"'
                        USING ERRCODE = 'check_violation';
                END IF;

                IF NEW.config_type IN ('nonnegative_money','positive_money','nonnegative_integer','positive_integer','percent') THEN
                    IF jsonb_typeof(v -> 'v') <> 'number' THEN
                        RAISE EXCEPTION 'governed config type % requires a numeric value', NEW.config_type
                            USING ERRCODE = 'check_violation';
                    END IF;
                    scalar_text := v ->> 'v';
                    IF scalar_text !~ '^[0-9]+$' THEN
                        RAISE EXCEPTION 'governed config numeric value must be a whole number'
                            USING ERRCODE = 'check_violation';
                    END IF;
                    scalar_num := scalar_text::numeric;
                    IF NEW.config_type IN ('positive_money','positive_integer') AND scalar_num < 1 THEN
                        RAISE EXCEPTION 'governed config type % requires a positive value', NEW.config_type
                            USING ERRCODE = 'check_violation';
                    END IF;
                    IF NEW.config_type = 'percent' AND (scalar_num < 0 OR scalar_num > 100) THEN
                        RAISE EXCEPTION 'governed config type percent requires a value between 0 and 100'
                            USING ERRCODE = 'check_violation';
                    END IF;
                ELSIF NEW.config_type = 'approver_reference' THEN
                    IF jsonb_typeof(v -> 'v') <> 'string' OR btrim(v ->> 'v') = '' THEN
                        RAISE EXCEPTION 'governed config type approver_reference requires a non-empty string'
                            USING ERRCODE = 'check_violation';
                    END IF;
                ELSE
                    RAISE EXCEPTION 'unsupported governed config_type %', NEW.config_type
                        USING ERRCODE = 'check_violation';
                END IF;

                IF TG_OP = 'INSERT' THEN
                    SELECT COALESCE(max(version_no), 0) INTO max_version
                      FROM governed_configs WHERE config_key = NEW.config_key;
                    IF NEW.version_no <= max_version THEN
                        RAISE EXCEPTION 'governed config % version % is not monotonic (max version %)',
                            NEW.config_key, NEW.version_no, max_version USING ERRCODE = 'check_violation';
                    END IF;
                END IF;

                RETURN NEW;
            END;
            $fn$ LANGUAGE plpgsql
        SQL);
        DB::statement('CREATE TRIGGER governed_configs_write_guard_trigger BEFORE INSERT OR UPDATE ON governed_configs FOR EACH ROW EXECUTE FUNCTION governed_configs_write_guard()');

        DB::statement(<<<'SQL'
            CREATE OR REPLACE FUNCTION governed_configs_immutability_guard() RETURNS trigger AS $fn$
            BEGIN
                -- The only permitted mutation is retiring the single OPEN
                -- (active) version into a finite-ended historical version when
                -- a successor supersedes it. Nothing else about any version may
                -- change, and a retired (ended) version is fully immutable.
                IF OLD.lifecycle_state = 'active'
                   AND NEW.lifecycle_state = 'ended'
                   AND OLD.effective_to IS NULL
                   AND NEW.effective_to IS NOT NULL
                   AND NEW.effective_to >= NEW.effective_from
                   AND NEW.value = OLD.value
                   AND NEW.config_type = OLD.config_type
                   AND NEW.effective_from = OLD.effective_from
                   AND NEW.config_key = OLD.config_key
                   AND NEW.version_no = OLD.version_no
                   AND NEW.approved_by = OLD.approved_by
                   AND NEW.supersedes_id IS NOT DISTINCT FROM OLD.supersedes_id
                   AND NEW.review_cycle IS NOT DISTINCT FROM OLD.review_cycle THEN
                    RETURN NEW;
                END IF;

                RAISE EXCEPTION 'governed config version is immutable (only an active open version may be retired by a successor)'
                    USING ERRCODE = 'check_violation';
            END;
            $fn$ LANGUAGE plpgsql
        SQL);
        DB::statement('CREATE TRIGGER governed_configs_immutability_guard_trigger BEFORE UPDATE ON governed_configs FOR EACH ROW EXECUTE FUNCTION governed_configs_immutability_guard()');

        DB::statement(<<<'SQL'
            CREATE OR REPLACE FUNCTION governed_configs_delete_guard() RETURNS trigger AS $fn$
            BEGIN
                RAISE EXCEPTION 'governed config history is append-only (versions are never deleted)'
                    USING ERRCODE = 'check_violation';
            END;
            $fn$ LANGUAGE plpgsql
        SQL);
        DB::statement('CREATE TRIGGER governed_configs_delete_guard_trigger BEFORE DELETE ON governed_configs FOR EACH ROW EXECUTE FUNCTION governed_configs_delete_guard()');
    }

    public function down(): void
    {
        DB::statement('DROP TRIGGER IF EXISTS governed_configs_delete_guard_trigger ON governed_configs');
        DB::statement('DROP FUNCTION IF EXISTS governed_configs_delete_guard()');
        DB::statement('DROP TRIGGER IF EXISTS governed_configs_immutability_guard_trigger ON governed_configs');
        DB::statement('DROP FUNCTION IF EXISTS governed_configs_immutability_guard()');
        DB::statement('DROP TRIGGER IF EXISTS governed_configs_write_guard_trigger ON governed_configs');
        DB::statement('DROP FUNCTION IF EXISTS governed_configs_write_guard()');
        DB::statement('DROP TRIGGER IF EXISTS governed_config_definitions_append_only_trigger ON governed_config_definitions');
        DB::statement('DROP FUNCTION IF EXISTS governed_config_definitions_append_only()');
        Schema::dropIfExists('governed_configs');
        Schema::dropIfExists('governed_config_definitions');
    }
};
