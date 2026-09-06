<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Schema;

return new class extends Migration
{
    public function up(): void
    {
        Schema::create('final_settlements', function (Blueprint $table): void {
            $table->char('id', 36)->primary();
            $table->char('employment_id', 36);
            $table->decimal('amount', 14, 2);
            $table->string('basis');
            $table->char('prepared_by', 36);
            $table->char('approved_by', 36);
            $table->timestamps();
            $table->foreign('employment_id')->references('id')->on('employments');
        });
        DB::statement('ALTER TABLE final_settlements ADD CONSTRAINT final_settlements_amount_check CHECK (amount >= 0)');
        DB::statement(<<<'SQL'
            CREATE OR REPLACE FUNCTION final_settlements_immutable() RETURNS trigger AS $fn$
            BEGIN
                RAISE EXCEPTION 'final settlements are immutable approved results';
            END;
            $fn$ LANGUAGE plpgsql;
            SQL);
        DB::statement('CREATE TRIGGER final_settlements_immutable_trigger BEFORE UPDATE OR DELETE ON final_settlements FOR EACH ROW EXECUTE FUNCTION final_settlements_immutable()');
    }

    public function down(): void
    {
        DB::statement('DROP TRIGGER IF EXISTS final_settlements_immutable_trigger ON final_settlements');
        DB::statement('DROP FUNCTION IF EXISTS final_settlements_immutable()');
        Schema::dropIfExists('final_settlements');
    }
};
