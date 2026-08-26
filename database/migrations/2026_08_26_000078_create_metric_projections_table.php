<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Schema;

return new class extends Migration
{
    public function up(): void
    {
        Schema::create('metric_projections', function (Blueprint $table): void {
            $table->char('id', 36)->primary();
            $table->char('metric_version_id', 36);
            $table->string('period_key');
            $table->string('scope_type');
            $table->char('scope_id', 36)->nullable();
            $table->decimal('value', 16, 4);
            $table->string('completeness');
            $table->jsonb('meta');
            $table->timestamp('computed_at');
            $table->char('computed_by', 36);
            $table->timestamps();
            $table->foreign('metric_version_id')->references('id')->on('metric_versions');
        });
        DB::statement("ALTER TABLE metric_projections ADD CONSTRAINT metric_projections_scope_type_check CHECK (scope_type IN ('global','student','class','fund'))");
        DB::statement("ALTER TABLE metric_projections ADD CONSTRAINT metric_projections_completeness_check CHECK (completeness IN ('complete','stale'))");
        DB::statement('CREATE UNIQUE INDEX metric_projections_one_slice ON metric_projections (metric_version_id, period_key, scope_type, COALESCE(scope_id, \'00000000-0000-0000-0000-000000000000\'))');
        DB::statement(<<<'SQL'
            CREATE OR REPLACE FUNCTION metric_projections_rebuild_only() RETURNS trigger AS $fn$
            BEGIN
                IF NEW.metric_version_id <> OLD.metric_version_id OR NEW.period_key <> OLD.period_key OR NEW.scope_type <> OLD.scope_type OR NEW.scope_id IS DISTINCT FROM OLD.scope_id THEN
                    RAISE EXCEPTION 'a projection slice is rebuildable in place; its identity (version, period, scope) never changes';
                END IF;
                RETURN NEW;
            END;
            $fn$ LANGUAGE plpgsql;
            SQL);
        DB::statement('CREATE TRIGGER metric_projections_rebuild_only_trigger BEFORE UPDATE ON metric_projections FOR EACH ROW EXECUTE FUNCTION metric_projections_rebuild_only()');
    }

    public function down(): void
    {
        DB::statement('DROP TRIGGER IF EXISTS metric_projections_rebuild_only_trigger ON metric_projections');
        DB::statement('DROP FUNCTION IF EXISTS metric_projections_rebuild_only()');
        Schema::dropIfExists('metric_projections');
    }
};
