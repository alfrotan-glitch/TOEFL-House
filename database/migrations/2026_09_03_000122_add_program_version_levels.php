<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Schema;

/**
 * WP-2 F2 (WP2-DEC-02): ProgramVersionLevel / CEFR model.
 *
 * Adds the authoritative academic level/version entity. A level is an ordered
 * child of exactly one immutable ProgramVersion (level_key and ordinal unique
 * per version). A class may optionally target a level; when it does, the level
 * must belong to the SAME program version the class belongs to (cross-version
 * integrity enforced by a schema trigger). Levels are additive — a published
 * version's history is never rewritten, and pre-existing classes keep a NULL
 * level (no fabricated level backfill).
 */
return new class extends Migration
{
    public function up(): void
    {
        Schema::create('program_version_levels', function (Blueprint $table): void {
            $table->char('id', 36)->primary();
            $table->char('program_version_id', 36);
            $table->string('level_key');
            $table->integer('ordinal');
            $table->string('title');
            $table->string('cefr_ref')->nullable();
            $table->string('lifecycle_state');
            $table->timestamps();
            $table->foreign('program_version_id')->references('id')->on('program_versions');
            $table->unique(['program_version_id', 'level_key']);
            $table->unique(['program_version_id', 'ordinal']);
        });
        DB::statement('ALTER TABLE program_version_levels ADD CONSTRAINT program_version_levels_ordinal_positive CHECK (ordinal >= 1)');

        Schema::table('classes', function (Blueprint $table): void {
            $table->char('program_version_level_id', 36)->nullable();
            $table->foreign('program_version_level_id')->references('id')->on('program_version_levels');
        });

        // A class's level must belong to the class's own program version.
        DB::statement(<<<'SQL'
            CREATE OR REPLACE FUNCTION class_level_matches_class_version() RETURNS trigger AS $fn$
            DECLARE
                level_version char(36);
            BEGIN
                IF NEW.program_version_level_id IS NOT NULL THEN
                    SELECT program_version_id INTO level_version
                      FROM program_version_levels WHERE id = NEW.program_version_level_id;
                    IF level_version IS NULL THEN
                        RETURN NEW; -- foreign key on program_version_level_id reports the missing level
                    END IF;
                    IF NEW.program_version_id <> level_version THEN
                        RAISE EXCEPTION 'class level does not belong to the class program version'
                            USING ERRCODE = 'check_violation';
                    END IF;
                END IF;
                RETURN NEW;
            END;
            $fn$ LANGUAGE plpgsql
        SQL);
        DB::statement('CREATE TRIGGER classes_level_version_matches BEFORE INSERT OR UPDATE OF program_version_level_id, program_version_id ON classes FOR EACH ROW EXECUTE FUNCTION class_level_matches_class_version()');
    }

    public function down(): void
    {
        DB::statement('DROP TRIGGER IF EXISTS classes_level_version_matches ON classes');
        DB::statement('DROP FUNCTION IF EXISTS class_level_matches_class_version()');

        Schema::table('classes', function (Blueprint $table): void {
            $table->dropForeign(['program_version_level_id']);
            $table->dropColumn('program_version_level_id');
        });
        Schema::dropIfExists('program_version_levels');
    }
};
