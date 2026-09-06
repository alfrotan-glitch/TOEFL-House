<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Schema;

return new class extends Migration
{
    public function up(): void
    {
        Schema::create('refunds', function (Blueprint $table): void {
            $table->char('id', 36)->primary();
            $table->char('payment_id', 36);
            $table->char('period_id', 36);
            $table->decimal('amount', 14, 2);
            $table->string('reason');
            $table->char('requested_by', 36);
            $table->char('approved_by', 36);
            $table->timestamps();
            $table->foreign('payment_id')->references('id')->on('payments');
            $table->foreign('period_id')->references('id')->on('financial_periods');
        });
        DB::statement('ALTER TABLE refunds ADD CONSTRAINT refunds_amount_check CHECK (amount > 0)');
        DB::statement(<<<'SQL'
            CREATE OR REPLACE FUNCTION refunds_immutable() RETURNS trigger AS $fn$
            BEGIN
                RAISE EXCEPTION 'refunds are immutable financial history';
            END;
            $fn$ LANGUAGE plpgsql;
            SQL);
        DB::statement('CREATE TRIGGER refunds_immutable_trigger BEFORE UPDATE OR DELETE ON refunds FOR EACH ROW EXECUTE FUNCTION refunds_immutable()');
    }

    public function down(): void
    {
        DB::statement('DROP TRIGGER IF EXISTS refunds_immutable_trigger ON refunds');
        DB::statement('DROP FUNCTION IF EXISTS refunds_immutable()');
        Schema::dropIfExists('refunds');
    }
};
