<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Schema;

return new class extends Migration
{
    public function up(): void
    {
        Schema::create('opening_entries', function (Blueprint $table): void {
            $table->char('id', 36)->primary();
            $table->char('opening_state_id', 36);
            $table->string('category');
            $table->decimal('amount', 14, 2);
            $table->string('currency', 3);
            $table->char('person_id', 36)->nullable();
            $table->char('student_id', 36)->nullable();
            $table->char('employment_id', 36)->nullable();
            $table->char('asset_account_id', 36)->nullable();
            $table->char('equity_account_id', 36)->nullable();
            $table->string('source_ref');
            $table->date('effective_on');
            $table->string('description');
            $table->char('prepared_by', 36);
            $table->timestamps();
            $table->foreign('opening_state_id')->references('id')->on('opening_states');
            $table->foreign('person_id')->references('id')->on('people');
            $table->foreign('student_id')->references('id')->on('students');
            $table->foreign('employment_id')->references('id')->on('employments');
            $table->foreign('asset_account_id')->references('id')->on('accounts');
            $table->foreign('equity_account_id')->references('id')->on('accounts');
        });
        DB::statement("ALTER TABLE opening_entries ADD CONSTRAINT opening_entries_category_check CHECK (category IN ('student_receivable','teacher_salary_payable','book_receivable','other_receivable','other_payable','cash_position'))");
        DB::statement('ALTER TABLE opening_entries ADD CONSTRAINT opening_entries_amount_check CHECK (amount > 0)');
        DB::statement("ALTER TABLE opening_entries ADD CONSTRAINT opening_entries_currency_check CHECK (currency IN ('AFN'))");
        DB::statement("ALTER TABLE opening_entries ADD CONSTRAINT opening_entries_student_shape_check CHECK ((category IN ('student_receivable','book_receivable') AND student_id IS NOT NULL) OR (category NOT IN ('student_receivable','book_receivable')))");
        DB::statement("ALTER TABLE opening_entries ADD CONSTRAINT opening_entries_teacher_shape_check CHECK ((category = 'teacher_salary_payable' AND person_id IS NOT NULL) OR category <> 'teacher_salary_payable')");
        DB::statement("ALTER TABLE opening_entries ADD CONSTRAINT opening_entries_cash_shape_check CHECK ((category = 'cash_position' AND asset_account_id IS NOT NULL AND equity_account_id IS NOT NULL) OR category <> 'cash_position')");
        DB::statement('CREATE UNIQUE INDEX opening_entries_one_source_ref ON opening_entries (opening_state_id, source_ref)');
        DB::statement(<<<'SQL'
            CREATE OR REPLACE FUNCTION opening_entries_opening_evidence() RETURNS trigger AS $fn$
            DECLARE parent_status text;
            BEGIN
                SELECT status INTO parent_status FROM opening_states WHERE id = NEW.opening_state_id;
                IF parent_status IS DISTINCT FROM 'draft' THEN
                    RAISE EXCEPTION 'opening entries may be recorded only while the opening state is a draft';
                END IF;
                RETURN NEW;
            END;
            $fn$ LANGUAGE plpgsql;
            SQL);
        DB::statement('CREATE TRIGGER opening_entries_draft_only_insert_trigger BEFORE INSERT ON opening_entries FOR EACH ROW EXECUTE FUNCTION opening_entries_opening_evidence()');
        DB::statement(<<<'SQL'
            CREATE OR REPLACE FUNCTION opening_entries_immutable() RETURNS trigger AS $fn$
            BEGIN
                RAISE EXCEPTION 'opening entries are immutable opening evidence';
            END;
            $fn$ LANGUAGE plpgsql;
            SQL);
        DB::statement('CREATE TRIGGER opening_entries_immutable_trigger BEFORE UPDATE OR DELETE ON opening_entries FOR EACH ROW EXECUTE FUNCTION opening_entries_immutable()');
    }

    public function down(): void
    {
        DB::statement('DROP TRIGGER IF EXISTS opening_entries_immutable_trigger ON opening_entries');
        DB::statement('DROP FUNCTION IF EXISTS opening_entries_immutable()');
        DB::statement('DROP TRIGGER IF EXISTS opening_entries_draft_only_insert_trigger ON opening_entries');
        DB::statement('DROP FUNCTION IF EXISTS opening_entries_opening_evidence()');
        Schema::dropIfExists('opening_entries');
    }
};
