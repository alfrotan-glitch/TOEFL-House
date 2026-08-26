<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Schema;

return new class extends Migration
{
    public function up(): void
    {
        Schema::create('payroll_periods', function (Blueprint $table): void {
            $table->char('id', 36)->primary();
            $table->string('period_key');
            $table->date('date_from');
            $table->date('date_to');
            $table->string('lifecycle_state');
            $table->timestamps();
        });
        DB::statement("ALTER TABLE payroll_periods ADD CONSTRAINT payroll_periods_lifecycle_state_check CHECK (lifecycle_state IN ('open','calculating','closed'))");
        DB::statement('ALTER TABLE payroll_periods ADD CONSTRAINT payroll_periods_period_check CHECK (date_to >= date_from)');
        DB::statement('CREATE UNIQUE INDEX payroll_periods_key_unique ON payroll_periods (period_key)');
        DB::statement(<<<'SQL'
            CREATE OR REPLACE FUNCTION payroll_periods_closed_immutable() RETURNS trigger AS $fn$
            BEGIN
                IF OLD.lifecycle_state = 'closed' THEN
                    RAISE EXCEPTION 'closed payroll periods are immutable; reopening and mutation are rejected';
                END IF;
                RETURN NEW;
            END;
            $fn$ LANGUAGE plpgsql;
            SQL);
        DB::statement('CREATE TRIGGER payroll_periods_closed_immutable_trigger BEFORE UPDATE OR DELETE ON payroll_periods FOR EACH ROW EXECUTE FUNCTION payroll_periods_closed_immutable()');
    }

    public function down(): void
    {
        DB::statement('DROP TRIGGER IF EXISTS payroll_periods_closed_immutable_trigger ON payroll_periods');
        DB::statement('DROP FUNCTION IF EXISTS payroll_periods_closed_immutable()');
        Schema::dropIfExists('payroll_periods');
    }
};
