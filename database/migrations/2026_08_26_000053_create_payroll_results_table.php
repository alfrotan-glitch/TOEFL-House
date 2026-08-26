<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Schema;

return new class extends Migration
{
    public function up(): void
    {
        Schema::create('payroll_results', function (Blueprint $table): void {
            $table->char('id', 36)->primary();
            $table->char('calculation_id', 36);
            $table->char('period_id', 36);
            $table->char('employment_id', 36);
            $table->decimal('amount', 14, 2);
            $table->string('lifecycle_state');
            $table->char('approved_by', 36);
            $table->timestamps();
            $table->foreign('calculation_id')->references('id')->on('payroll_calculations');
            $table->foreign('period_id')->references('id')->on('payroll_periods');
            $table->foreign('employment_id')->references('id')->on('employments');
        });
        DB::statement("ALTER TABLE payroll_results ADD CONSTRAINT payroll_results_lifecycle_state_check CHECK (lifecycle_state IN ('approved'))");
        DB::statement('ALTER TABLE payroll_results ADD CONSTRAINT payroll_results_amount_check CHECK (amount >= 0)');
        DB::statement('CREATE UNIQUE INDEX payroll_results_one_per_calculation ON payroll_results (calculation_id)');
        DB::statement(<<<'SQL'
            CREATE OR REPLACE FUNCTION payroll_results_immutable() RETURNS trigger AS $fn$
            BEGIN
                RAISE EXCEPTION 'approved payroll results are immutable; corrections and reversals append adjustments';
            END;
            $fn$ LANGUAGE plpgsql;
            SQL);
        DB::statement('CREATE TRIGGER payroll_results_immutable_trigger BEFORE UPDATE OR DELETE ON payroll_results FOR EACH ROW EXECUTE FUNCTION payroll_results_immutable()');
    }

    public function down(): void
    {
        DB::statement('DROP TRIGGER IF EXISTS payroll_results_immutable_trigger ON payroll_results');
        DB::statement('DROP FUNCTION IF EXISTS payroll_results_immutable()');
        Schema::dropIfExists('payroll_results');
    }
};
