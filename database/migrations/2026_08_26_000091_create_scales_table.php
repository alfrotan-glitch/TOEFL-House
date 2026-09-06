<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Schema;

return new class extends Migration
{
    public function up(): void
    {
        Schema::create('scales', function (Blueprint $table): void {
            $table->char('id', 36)->primary();
            $table->string('key');
            $table->string('name');
            $table->integer('rank_order');
            $table->string('lifecycle_state');
            $table->timestamps();
        });
        DB::statement("ALTER TABLE scales ADD CONSTRAINT scales_lifecycle_state_check CHECK (lifecycle_state IN ('active','retired'))");
        DB::statement('ALTER TABLE scales ADD CONSTRAINT scales_rank_order_check CHECK (rank_order > 0)');
        DB::statement('CREATE UNIQUE INDEX scales_key_unique ON scales (key)');
        DB::statement('CREATE UNIQUE INDEX scales_rank_order_unique ON scales (rank_order)');
        DB::statement(<<<'SQL'
            CREATE OR REPLACE FUNCTION scales_catalog_guard() RETURNS trigger AS $fn$
            BEGIN
                IF TG_OP = 'DELETE' THEN
                    RAISE EXCEPTION 'scales are retained compensation history and cannot be deleted';
                END IF;
                IF NEW.key <> OLD.key OR NEW.rank_order <> OLD.rank_order THEN
                    RAISE EXCEPTION 'scale identity (key, rank) is immutable';
                END IF;
                IF OLD.lifecycle_state = 'retired' THEN
                    RAISE EXCEPTION 'retired scales are immutable compensation history';
                END IF;
                RETURN NEW;
            END;
            $fn$ LANGUAGE plpgsql;
            SQL);
        DB::statement('CREATE TRIGGER scales_catalog_guard_trigger BEFORE UPDATE OR DELETE ON scales FOR EACH ROW EXECUTE FUNCTION scales_catalog_guard()');
    }

    public function down(): void
    {
        DB::statement('DROP TRIGGER IF EXISTS scales_catalog_guard_trigger ON scales');
        DB::statement('DROP FUNCTION IF EXISTS scales_catalog_guard()');
        Schema::dropIfExists('scales');
    }
};
