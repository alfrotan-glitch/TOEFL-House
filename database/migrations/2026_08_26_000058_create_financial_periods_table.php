<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Schema;

return new class extends Migration
{
    public function up(): void
    {
        Schema::create('financial_periods', function (Blueprint $table): void {
            $table->char('id', 36)->primary();
            $table->string('period_key');
            $table->date('date_from');
            $table->date('date_to');
            $table->string('lifecycle_state');
            $table->char('closed_by', 36)->nullable();
            $table->timestamps();
        });
        DB::statement("ALTER TABLE financial_periods ADD CONSTRAINT financial_periods_lifecycle_state_check CHECK (lifecycle_state IN ('open','closed'))");
        DB::statement('ALTER TABLE financial_periods ADD CONSTRAINT financial_periods_period_check CHECK (date_to >= date_from)');
        DB::statement('CREATE UNIQUE INDEX financial_periods_key_unique ON financial_periods (period_key)');
        DB::statement(<<<'SQL'
            CREATE OR REPLACE FUNCTION financial_periods_closed_immutable() RETURNS trigger AS $fn$
            BEGIN
                IF OLD.lifecycle_state = 'closed' THEN
                    RAISE EXCEPTION 'closed financial periods are immutable; reopening and mutation are rejected';
                END IF;
                RETURN NEW;
            END;
            $fn$ LANGUAGE plpgsql;
            SQL);
        DB::statement('CREATE TRIGGER financial_periods_closed_immutable_trigger BEFORE UPDATE OR DELETE ON financial_periods FOR EACH ROW EXECUTE FUNCTION financial_periods_closed_immutable()');
    }

    public function down(): void
    {
        DB::statement('DROP TRIGGER IF EXISTS financial_periods_closed_immutable_trigger ON financial_periods');
        DB::statement('DROP FUNCTION IF EXISTS financial_periods_closed_immutable()');
        Schema::dropIfExists('financial_periods');
    }
};
