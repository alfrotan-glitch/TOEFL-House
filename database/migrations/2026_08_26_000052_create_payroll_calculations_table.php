<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Schema;

return new class extends Migration
{
    public function up(): void
    {
        Schema::create('payroll_calculations', function (Blueprint $table): void {
            $table->char('id', 36)->primary();
            $table->char('period_id', 36);
            $table->char('employment_id', 36);
            $table->decimal('base_amount', 14, 2);
            $table->jsonb('snapshot');
            $table->string('lifecycle_state');
            $table->text('held_reason')->nullable();
            $table->char('prepared_by', 36);
            $table->timestamps();
            $table->foreign('period_id')->references('id')->on('payroll_periods');
            $table->foreign('employment_id')->references('id')->on('employments');
        });
        DB::statement("ALTER TABLE payroll_calculations ADD CONSTRAINT payroll_calculations_lifecycle_state_check CHECK (lifecycle_state IN ('prepared','held','resulted','superseded'))");
        DB::statement("CREATE UNIQUE INDEX payroll_calculations_one_live_per_period_employment ON payroll_calculations (period_id, employment_id) WHERE lifecycle_state IN ('prepared','held','resulted')");
        DB::statement(<<<'SQL'
            CREATE OR REPLACE FUNCTION payroll_calculations_history() RETURNS trigger AS $fn$
            BEGIN
                IF OLD.lifecycle_state IN ('resulted','superseded') THEN
                    RAISE EXCEPTION 'consumed or superseded calculations are retained history and cannot be rewritten or deleted';
                END IF;
                RETURN NEW;
            END;
            $fn$ LANGUAGE plpgsql;
            SQL);
        DB::statement('CREATE TRIGGER payroll_calculations_history_trigger BEFORE UPDATE OR DELETE ON payroll_calculations FOR EACH ROW EXECUTE FUNCTION payroll_calculations_history()');
    }

    public function down(): void
    {
        DB::statement('DROP TRIGGER IF EXISTS payroll_calculations_history_trigger ON payroll_calculations');
        DB::statement('DROP FUNCTION IF EXISTS payroll_calculations_history()');
        Schema::dropIfExists('payroll_calculations');
    }
};
