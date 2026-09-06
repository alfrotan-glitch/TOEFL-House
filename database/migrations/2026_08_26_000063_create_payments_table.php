<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Schema;

return new class extends Migration
{
    public function up(): void
    {
        Schema::create('payments', function (Blueprint $table): void {
            $table->char('id', 36)->primary();
            $table->char('period_id', 36);
            $table->char('student_id', 36);
            $table->decimal('amount', 14, 2);
            $table->string('method');
            $table->string('payer_ref');
            $table->date('received_on');
            $table->char('recorded_by', 36);
            $table->timestamps();
            $table->foreign('period_id')->references('id')->on('financial_periods');
            $table->foreign('student_id')->references('id')->on('students');
        });
        DB::statement('ALTER TABLE payments ADD CONSTRAINT payments_amount_check CHECK (amount > 0)');
        DB::statement('CREATE UNIQUE INDEX payments_payer_ref_unique ON payments (payer_ref)');
        DB::statement(<<<'SQL'
            CREATE OR REPLACE FUNCTION payments_immutable() RETURNS trigger AS $fn$
            BEGIN
                RAISE EXCEPTION 'posted payments are immutable source facts; returns happen through refunds';
            END;
            $fn$ LANGUAGE plpgsql;
            SQL);
        DB::statement('CREATE TRIGGER payments_immutable_trigger BEFORE UPDATE OR DELETE ON payments FOR EACH ROW EXECUTE FUNCTION payments_immutable()');
    }

    public function down(): void
    {
        DB::statement('DROP TRIGGER IF EXISTS payments_immutable_trigger ON payments');
        DB::statement('DROP FUNCTION IF EXISTS payments_immutable()');
        Schema::dropIfExists('payments');
    }
};
