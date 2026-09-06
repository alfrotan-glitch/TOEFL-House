<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Schema;

return new class extends Migration
{
    public function up(): void
    {
        Schema::create('book_copies', function (Blueprint $table): void {
            $table->char('id', 36)->primary();
            $table->string('code');
            $table->string('title');
            $table->date('acquired_on');
            $table->timestamps();
        });
        DB::statement('CREATE UNIQUE INDEX book_copies_code_unique ON book_copies (code)');
        DB::statement(<<<'SQL'
            CREATE OR REPLACE FUNCTION book_copies_immutable() RETURNS trigger AS $fn$
            BEGIN
                RAISE EXCEPTION 'book copies are immutable catalog history; circulation state is derived from issuances';
            END;
            $fn$ LANGUAGE plpgsql;
            SQL);
        DB::statement('CREATE TRIGGER book_copies_immutable_trigger BEFORE UPDATE OR DELETE ON book_copies FOR EACH ROW EXECUTE FUNCTION book_copies_immutable()');
    }

    public function down(): void
    {
        DB::statement('DROP TRIGGER IF EXISTS book_copies_immutable_trigger ON book_copies');
        DB::statement('DROP FUNCTION IF EXISTS book_copies_immutable()');
        Schema::dropIfExists('book_copies');
    }
};
