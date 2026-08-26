<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Schema;

return new class extends Migration
{
    public function up(): void
    {
        Schema::create('obligation_lines', function (Blueprint $table): void {
            $table->char('id', 36)->primary();
            $table->char('obligation_id', 36);
            $table->string('category');
            $table->decimal('amount', 14, 2);
            $table->string('source_ref');
            $table->timestamps();
            $table->foreign('obligation_id')->references('id')->on('obligations');
        });
        DB::statement('ALTER TABLE obligation_lines ADD CONSTRAINT obligation_lines_amount_check CHECK (amount > 0)');
        DB::statement(<<<'SQL'
            CREATE OR REPLACE FUNCTION obligation_lines_immutable() RETURNS trigger AS $fn$
            BEGIN
                RAISE EXCEPTION 'obligation lines are immutable atomic charges';
            END;
            $fn$ LANGUAGE plpgsql;
            SQL);
        DB::statement('CREATE TRIGGER obligation_lines_immutable_trigger BEFORE UPDATE OR DELETE ON obligation_lines FOR EACH ROW EXECUTE FUNCTION obligation_lines_immutable()');
    }

    public function down(): void
    {
        DB::statement('DROP TRIGGER IF EXISTS obligation_lines_immutable_trigger ON obligation_lines');
        DB::statement('DROP FUNCTION IF EXISTS obligation_lines_immutable()');
        Schema::dropIfExists('obligation_lines');
    }
};
