<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Schema;

return new class extends Migration
{
    public function up(): void
    {
        Schema::create('fund_allocations', function (Blueprint $table): void {
            $table->char('id', 36)->primary();
            $table->char('fund_id', 36);
            $table->char('obligation_line_id', 36);
            $table->decimal('amount', 14, 2);
            $table->string('reason');
            $table->char('allocated_by', 36);
            $table->timestamps();
            $table->foreign('fund_id')->references('id')->on('funding_sources');
            $table->foreign('obligation_line_id')->references('id')->on('obligation_lines');
        });
        DB::statement('ALTER TABLE fund_allocations ADD CONSTRAINT fund_allocations_amount_check CHECK (amount > 0)');
        DB::statement(<<<'SQL'
            CREATE OR REPLACE FUNCTION fund_allocations_immutable() RETURNS trigger AS $fn$
            BEGIN
                RAISE EXCEPTION 'fund allocations are immutable funding history; utilization is derived from them';
            END;
            $fn$ LANGUAGE plpgsql;
            SQL);
        DB::statement('CREATE TRIGGER fund_allocations_immutable_trigger BEFORE UPDATE OR DELETE ON fund_allocations FOR EACH ROW EXECUTE FUNCTION fund_allocations_immutable()');
    }

    public function down(): void
    {
        DB::statement('DROP TRIGGER IF EXISTS fund_allocations_immutable_trigger ON fund_allocations');
        DB::statement('DROP FUNCTION IF EXISTS fund_allocations_immutable()');
        Schema::dropIfExists('fund_allocations');
    }
};
