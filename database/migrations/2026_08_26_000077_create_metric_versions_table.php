<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Schema;

return new class extends Migration
{
    public function up(): void
    {
        Schema::create('metric_versions', function (Blueprint $table): void {
            $table->char('id', 36)->primary();
            $table->char('metric_id', 36);
            $table->integer('version_no');
            $table->text('calculation_spec');
            $table->date('effective_from');
            $table->char('created_by', 36);
            $table->timestamps();
            $table->foreign('metric_id')->references('id')->on('metric_definitions');
        });
        DB::statement('ALTER TABLE metric_versions ADD CONSTRAINT metric_versions_positive CHECK (version_no > 0)');
        DB::statement('CREATE UNIQUE INDEX metric_versions_one_per_no ON metric_versions (metric_id, version_no)');
        DB::statement(<<<'SQL'
            CREATE OR REPLACE FUNCTION metric_versions_immutable() RETURNS trigger AS $fn$
            BEGIN
                RAISE EXCEPTION 'metric calculation versions are immutable history; historical reports keep their original definition';
            END;
            $fn$ LANGUAGE plpgsql;
            SQL);
        DB::statement('CREATE TRIGGER metric_versions_immutable_trigger BEFORE UPDATE OR DELETE ON metric_versions FOR EACH ROW EXECUTE FUNCTION metric_versions_immutable()');
    }

    public function down(): void
    {
        DB::statement('DROP TRIGGER IF EXISTS metric_versions_immutable_trigger ON metric_versions');
        DB::statement('DROP FUNCTION IF EXISTS metric_versions_immutable()');
        Schema::dropIfExists('metric_versions');
    }
};
