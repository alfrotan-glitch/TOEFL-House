<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Schema;

return new class extends Migration
{
    public function up(): void
    {
        Schema::create('payroll_adjustments', function (Blueprint $table): void {
            $table->char('id', 36)->primary();
            $table->char('result_id', 36);
            $table->string('kind');
            $table->decimal('amount', 14, 2);
            $table->string('reason');
            $table->char('approved_by', 36);
            $table->timestamps();
            $table->foreign('result_id')->references('id')->on('payroll_results');
        });
        DB::statement("ALTER TABLE payroll_adjustments ADD CONSTRAINT payroll_adjustments_kind_check CHECK (kind IN ('adjustment','reversal'))");
        DB::statement(<<<'SQL'
            CREATE OR REPLACE FUNCTION payroll_adjustments_append_only() RETURNS trigger AS $fn$
            BEGIN
                RAISE EXCEPTION 'payroll adjustments are approved history and cannot be rewritten or deleted';
            END;
            $fn$ LANGUAGE plpgsql;
            SQL);
        DB::statement('CREATE TRIGGER payroll_adjustments_append_only_trigger BEFORE UPDATE OR DELETE ON payroll_adjustments FOR EACH ROW EXECUTE FUNCTION payroll_adjustments_append_only()');
    }

    public function down(): void
    {
        DB::statement('DROP TRIGGER IF EXISTS payroll_adjustments_append_only_trigger ON payroll_adjustments');
        DB::statement('DROP FUNCTION IF EXISTS payroll_adjustments_append_only()');
        Schema::dropIfExists('payroll_adjustments');
    }
};
