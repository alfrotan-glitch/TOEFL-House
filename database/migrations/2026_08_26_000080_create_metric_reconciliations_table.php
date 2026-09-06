<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Schema;

return new class extends Migration
{
    public function up(): void
    {
        Schema::create('metric_reconciliations', function (Blueprint $table): void {
            $table->char('id', 36)->primary();
            $table->char('metric_id', 36);
            $table->string('period_key');
            $table->string('scope_type');
            $table->char('scope_id', 36)->nullable();
            $table->decimal('reported_value', 16, 4);
            $table->decimal('authoritative_value', 16, 4);
            $table->decimal('variance', 16, 4);
            $table->string('status');
            $table->text('explanation')->nullable();
            $table->char('reconciled_by', 36);
            $table->timestamps();
            $table->foreign('metric_id')->references('id')->on('metric_definitions');
        });
        DB::statement("ALTER TABLE metric_reconciliations ADD CONSTRAINT metric_reconciliations_status_check CHECK (status IN ('matched','diverged'))");
        DB::statement('ALTER TABLE metric_reconciliations ADD CONSTRAINT metric_reconciliations_variance_check CHECK (variance = reported_value - authoritative_value)');
        DB::statement(<<<'SQL'
            CREATE OR REPLACE FUNCTION metric_reconciliations_immutable() RETURNS trigger AS $fn$
            BEGIN
                RAISE EXCEPTION 'reconciliation records are variance evidence history';
            END;
            $fn$ LANGUAGE plpgsql;
            SQL);
        DB::statement('CREATE TRIGGER metric_reconciliations_immutable_trigger BEFORE UPDATE OR DELETE ON metric_reconciliations FOR EACH ROW EXECUTE FUNCTION metric_reconciliations_immutable()');
    }

    public function down(): void
    {
        DB::statement('DROP TRIGGER IF EXISTS metric_reconciliations_immutable_trigger ON metric_reconciliations');
        DB::statement('DROP FUNCTION IF EXISTS metric_reconciliations_immutable()');
        Schema::dropIfExists('metric_reconciliations');
    }
};
