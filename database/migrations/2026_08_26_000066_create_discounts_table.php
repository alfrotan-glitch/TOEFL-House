<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Schema;

return new class extends Migration
{
    public function up(): void
    {
        Schema::create('discounts', function (Blueprint $table): void {
            $table->char('id', 36)->primary();
            $table->char('obligation_id', 36);
            $table->char('period_id', 36);
            $table->decimal('amount', 14, 2);
            $table->string('eligibility');
            $table->date('effective_from');
            $table->date('effective_to')->nullable();
            $table->string('reason');
            $table->string('lifecycle_state');
            $table->char('proposed_by', 36);
            $table->char('approved_by', 36)->nullable();
            $table->timestamps();
            $table->foreign('obligation_id')->references('id')->on('obligations');
            $table->foreign('period_id')->references('id')->on('financial_periods');
        });
        DB::statement("ALTER TABLE discounts ADD CONSTRAINT discounts_lifecycle_state_check CHECK (lifecycle_state IN ('proposed','approved'))");
        DB::statement('ALTER TABLE discounts ADD CONSTRAINT discounts_amount_check CHECK (amount > 0)');
        DB::statement('ALTER TABLE discounts ADD CONSTRAINT discounts_period_check CHECK (effective_to IS NULL OR effective_to >= effective_from)');
        DB::statement(<<<'SQL'
            CREATE OR REPLACE FUNCTION discounts_approved_immutable() RETURNS trigger AS $fn$
            BEGIN
                IF OLD.lifecycle_state = 'approved' THEN
                    RAISE EXCEPTION 'approved discounts are immutable; the original charge is preserved and a reversal is a controlled correction';
                END IF;
                RETURN NEW;
            END;
            $fn$ LANGUAGE plpgsql;
            SQL);
        DB::statement('CREATE TRIGGER discounts_approved_immutable_trigger BEFORE UPDATE OR DELETE ON discounts FOR EACH ROW EXECUTE FUNCTION discounts_approved_immutable()');
    }

    public function down(): void
    {
        DB::statement('DROP TRIGGER IF EXISTS discounts_approved_immutable_trigger ON discounts');
        DB::statement('DROP FUNCTION IF EXISTS discounts_approved_immutable()');
        Schema::dropIfExists('discounts');
    }
};
