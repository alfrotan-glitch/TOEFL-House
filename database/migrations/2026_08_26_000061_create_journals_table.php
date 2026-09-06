<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Schema;

return new class extends Migration
{
    public function up(): void
    {
        Schema::create('journals', function (Blueprint $table): void {
            $table->char('id', 36)->primary();
            $table->char('period_id', 36);
            $table->string('source_type');
            $table->char('source_id', 36)->nullable();
            $table->string('reason');
            $table->char('posted_by', 36);
            $table->timestamps();
            $table->foreign('period_id')->references('id')->on('financial_periods');
        });
        DB::statement("ALTER TABLE journals ADD CONSTRAINT journals_source_type_check CHECK (source_type IN ('obligation','payroll_result','journal','other'))");
        DB::statement(<<<'SQL'
            CREATE OR REPLACE FUNCTION journals_immutable() RETURNS trigger AS $fn$
            BEGIN
                RAISE EXCEPTION 'posted journals are immutable accounting records; corrections append reversals';
            END;
            $fn$ LANGUAGE plpgsql;
            SQL);
        DB::statement('CREATE TRIGGER journals_immutable_trigger BEFORE UPDATE OR DELETE ON journals FOR EACH ROW EXECUTE FUNCTION journals_immutable()');

        Schema::create('journal_lines', function (Blueprint $table): void {
            $table->char('id', 36)->primary();
            $table->char('journal_id', 36);
            $table->char('account_id', 36);
            $table->string('direction');
            $table->decimal('amount', 14, 2);
            $table->timestamps();
            $table->foreign('journal_id')->references('id')->on('journals');
            $table->foreign('account_id')->references('id')->on('accounts');
        });
        DB::statement("ALTER TABLE journal_lines ADD CONSTRAINT journal_lines_direction_check CHECK (direction IN ('debit','credit'))");
        DB::statement('ALTER TABLE journal_lines ADD CONSTRAINT journal_lines_amount_check CHECK (amount > 0)');
        DB::statement(<<<'SQL'
            CREATE OR REPLACE FUNCTION journal_lines_immutable() RETURNS trigger AS $fn$
            BEGIN
                RAISE EXCEPTION 'posted journal lines are immutable accounting records';
            END;
            $fn$ LANGUAGE plpgsql;
            SQL);
        DB::statement('CREATE TRIGGER journal_lines_immutable_trigger BEFORE UPDATE OR DELETE ON journal_lines FOR EACH ROW EXECUTE FUNCTION journal_lines_immutable()');
    }

    public function down(): void
    {
        DB::statement('DROP TRIGGER IF EXISTS journal_lines_immutable_trigger ON journal_lines');
        DB::statement('DROP FUNCTION IF EXISTS journal_lines_immutable()');
        Schema::dropIfExists('journal_lines');
        DB::statement('DROP TRIGGER IF EXISTS journals_immutable_trigger ON journals');
        DB::statement('DROP FUNCTION IF EXISTS journals_immutable()');
        Schema::dropIfExists('journals');
    }
};
