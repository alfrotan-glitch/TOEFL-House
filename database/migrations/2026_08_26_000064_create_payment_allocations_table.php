<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Schema;

return new class extends Migration
{
    public function up(): void
    {
        Schema::create('payment_allocations', function (Blueprint $table): void {
            $table->char('id', 36)->primary();
            $table->char('payment_id', 36);
            $table->char('obligation_id', 36);
            $table->decimal('amount', 14, 2);
            $table->char('allocated_by', 36);
            $table->timestamps();
            $table->foreign('payment_id')->references('id')->on('payments');
            $table->foreign('obligation_id')->references('id')->on('obligations');
        });
        DB::statement('ALTER TABLE payment_allocations ADD CONSTRAINT payment_allocations_amount_check CHECK (amount > 0)');
        DB::statement('CREATE UNIQUE INDEX payment_allocations_one_per_pair ON payment_allocations (payment_id, obligation_id)');
        DB::statement(<<<'SQL'
            CREATE OR REPLACE FUNCTION payment_allocations_immutable() RETURNS trigger AS $fn$
            BEGIN
                RAISE EXCEPTION 'payment allocations are immutable financial history';
            END;
            $fn$ LANGUAGE plpgsql;
            SQL);
        DB::statement('CREATE TRIGGER payment_allocations_immutable_trigger BEFORE UPDATE OR DELETE ON payment_allocations FOR EACH ROW EXECUTE FUNCTION payment_allocations_immutable()');
    }

    public function down(): void
    {
        DB::statement('DROP TRIGGER IF EXISTS payment_allocations_immutable_trigger ON payment_allocations');
        DB::statement('DROP FUNCTION IF EXISTS payment_allocations_immutable()');
        Schema::dropIfExists('payment_allocations');
    }
};
