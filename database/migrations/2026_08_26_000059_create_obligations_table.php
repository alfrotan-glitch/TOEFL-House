<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Schema;

return new class extends Migration
{
    public function up(): void
    {
        Schema::create('obligations', function (Blueprint $table): void {
            $table->char('id', 36)->primary();
            $table->char('period_id', 36);
            $table->char('student_id', 36);
            $table->string('source');
            $table->decimal('original_amount', 14, 2);
            $table->string('reason');
            $table->char('posted_by', 36);
            $table->timestamps();
            $table->foreign('period_id')->references('id')->on('financial_periods');
            $table->foreign('student_id')->references('id')->on('students');
        });
        DB::statement('ALTER TABLE obligations ADD CONSTRAINT obligations_amount_check CHECK (original_amount > 0)');
        DB::statement(<<<'SQL'
            CREATE OR REPLACE FUNCTION obligations_immutable() RETURNS trigger AS $fn$
            BEGIN
                RAISE EXCEPTION 'posted obligations are immutable source facts; corrections append adjustments';
            END;
            $fn$ LANGUAGE plpgsql;
            SQL);
        DB::statement('CREATE TRIGGER obligations_immutable_trigger BEFORE UPDATE OR DELETE ON obligations FOR EACH ROW EXECUTE FUNCTION obligations_immutable()');
    }

    public function down(): void
    {
        DB::statement('DROP TRIGGER IF EXISTS obligations_immutable_trigger ON obligations');
        DB::statement('DROP FUNCTION IF EXISTS obligations_immutable()');
        Schema::dropIfExists('obligations');
    }
};
