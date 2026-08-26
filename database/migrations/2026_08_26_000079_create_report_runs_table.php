<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Schema;

return new class extends Migration
{
    public function up(): void
    {
        Schema::create('report_runs', function (Blueprint $table): void {
            $table->char('id', 36)->primary();
            $table->char('metric_version_id', 36);
            $table->string('period_key');
            $table->string('scope_type');
            $table->char('scope_id', 36)->nullable();
            $table->jsonb('filters');
            $table->decimal('result', 16, 4);
            $table->string('reproducibility_hash');
            $table->char('executed_by', 36);
            $table->timestamps();
            $table->foreign('metric_version_id')->references('id')->on('metric_versions');
        });
        DB::statement("ALTER TABLE report_runs ADD CONSTRAINT report_runs_scope_type_check CHECK (scope_type IN ('global','student','class','fund'))");
        DB::statement(<<<'SQL'
            CREATE OR REPLACE FUNCTION report_runs_immutable() RETURNS trigger AS $fn$
            BEGIN
                RAISE EXCEPTION 'report runs are reproducible history and cannot be rewritten';
            END;
            $fn$ LANGUAGE plpgsql;
            SQL);
        DB::statement('CREATE TRIGGER report_runs_immutable_trigger BEFORE UPDATE OR DELETE ON report_runs FOR EACH ROW EXECUTE FUNCTION report_runs_immutable()');
    }

    public function down(): void
    {
        DB::statement('DROP TRIGGER IF EXISTS report_runs_immutable_trigger ON report_runs');
        DB::statement('DROP FUNCTION IF EXISTS report_runs_immutable()');
        Schema::dropIfExists('report_runs');
    }
};
