<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Schema;

return new class extends Migration
{
    public function up(): void
    {
        Schema::create('skills', function (Blueprint $table): void {
            $table->char('id', 36)->primary();
            $table->string('key');
            $table->string('name');
            $table->string('lifecycle_state');
            $table->timestamps();
        });
        DB::statement("ALTER TABLE skills ADD CONSTRAINT skills_lifecycle_state_check CHECK (lifecycle_state IN ('active','retired'))");
        DB::statement('CREATE UNIQUE INDEX skills_key_unique ON skills (key)');
        DB::statement(<<<'SQL'
            CREATE OR REPLACE FUNCTION skills_catalog_guard() RETURNS trigger AS $fn$
            BEGIN
                IF TG_OP = 'DELETE' THEN
                    RAISE EXCEPTION 'skills are retained catalog history and cannot be deleted';
                END IF;
                IF NEW.key <> OLD.key THEN
                    RAISE EXCEPTION 'skill identity (key) is immutable';
                END IF;
                IF OLD.lifecycle_state = 'retired' THEN
                    RAISE EXCEPTION 'retired skills are immutable catalog history';
                END IF;
                RETURN NEW;
            END;
            $fn$ LANGUAGE plpgsql;
            SQL);
        DB::statement('CREATE TRIGGER skills_catalog_guard_trigger BEFORE UPDATE OR DELETE ON skills FOR EACH ROW EXECUTE FUNCTION skills_catalog_guard()');
    }

    public function down(): void
    {
        DB::statement('DROP TRIGGER IF EXISTS skills_catalog_guard_trigger ON skills');
        DB::statement('DROP FUNCTION IF EXISTS skills_catalog_guard()');
        Schema::dropIfExists('skills');
    }
};
