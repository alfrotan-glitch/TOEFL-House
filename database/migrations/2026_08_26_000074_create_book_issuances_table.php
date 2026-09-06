<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Schema;

return new class extends Migration
{
    public function up(): void
    {
        Schema::create('book_issuances', function (Blueprint $table): void {
            $table->char('id', 36)->primary();
            $table->char('copy_id', 36);
            $table->char('borrower_person_id', 36);
            $table->date('issued_on');
            $table->date('due_on');
            $table->date('returned_on')->nullable();
            $table->string('lifecycle_state');
            $table->string('loss_evidence')->nullable();
            $table->char('issued_by', 36);
            $table->timestamps();
            $table->foreign('copy_id')->references('id')->on('book_copies');
            $table->foreign('borrower_person_id')->references('id')->on('people');
        });
        DB::statement("ALTER TABLE book_issuances ADD CONSTRAINT book_issuances_lifecycle_state_check CHECK (lifecycle_state IN ('issued','returned','lost'))");
        DB::statement('ALTER TABLE book_issuances ADD CONSTRAINT book_issuances_due_check CHECK (due_on >= issued_on)');
        DB::statement("CREATE UNIQUE INDEX book_issuances_one_open_per_copy ON book_issuances (copy_id) WHERE lifecycle_state = 'issued'");
        DB::statement(<<<'SQL'
            CREATE OR REPLACE FUNCTION book_issuances_terminal_immutable() RETURNS trigger AS $fn$
            BEGIN
                IF OLD.lifecycle_state IN ('returned','lost') THEN
                    RAISE EXCEPTION 'returned or lost issuances are retained custody history';
                END IF;
                RETURN NEW;
            END;
            $fn$ LANGUAGE plpgsql;
            SQL);
        DB::statement('CREATE TRIGGER book_issuances_terminal_immutable_trigger BEFORE UPDATE OR DELETE ON book_issuances FOR EACH ROW EXECUTE FUNCTION book_issuances_terminal_immutable()');
    }

    public function down(): void
    {
        DB::statement('DROP TRIGGER IF EXISTS book_issuances_terminal_immutable_trigger ON book_issuances');
        DB::statement('DROP FUNCTION IF EXISTS book_issuances_terminal_immutable()');
        Schema::dropIfExists('book_issuances');
    }
};
