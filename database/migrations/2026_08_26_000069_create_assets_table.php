<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Schema;

return new class extends Migration
{
    public function up(): void
    {
        Schema::create('assets', function (Blueprint $table): void {
            $table->char('id', 36)->primary();
            $table->string('code');
            $table->string('name');
            $table->string('category');
            $table->string('location');
            $table->date('acquired_on');
            $table->string('lifecycle_state');
            $table->timestamps();
        });
        DB::statement("ALTER TABLE assets ADD CONSTRAINT assets_lifecycle_state_check CHECK (lifecycle_state IN ('in_service','disposed'))");
        DB::statement('CREATE UNIQUE INDEX assets_code_unique ON assets (code)');
        DB::statement(<<<'SQL'
            CREATE OR REPLACE FUNCTION assets_disposed_immutable() RETURNS trigger AS $fn$
            BEGIN
                IF OLD.lifecycle_state = 'disposed' THEN
                    RAISE EXCEPTION 'disposed assets are retained history and cannot be rewritten or deleted';
                END IF;
                RETURN NEW;
            END;
            $fn$ LANGUAGE plpgsql;
            SQL);
        DB::statement('CREATE TRIGGER assets_disposed_immutable_trigger BEFORE UPDATE OR DELETE ON assets FOR EACH ROW EXECUTE FUNCTION assets_disposed_immutable()');
    }

    public function down(): void
    {
        DB::statement('DROP TRIGGER IF EXISTS assets_disposed_immutable_trigger ON assets');
        DB::statement('DROP FUNCTION IF EXISTS assets_disposed_immutable()');
        Schema::dropIfExists('assets');
    }
};
