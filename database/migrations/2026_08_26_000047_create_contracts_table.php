<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Schema;

return new class extends Migration
{
    public function up(): void
    {
        Schema::create('contracts', function (Blueprint $table): void {
            $table->char('id', 36)->primary();
            $table->char('employment_id', 36);
            $table->string('terms_summary');
            $table->string('signed_ref')->nullable();
            $table->string('lifecycle_state');
            $table->date('effective_from');
            $table->date('effective_to')->nullable();
            $table->char('signed_by', 36)->nullable();
            $table->timestamps();
            $table->foreign('employment_id')->references('id')->on('employments');
        });
        DB::statement("ALTER TABLE contracts ADD CONSTRAINT contracts_lifecycle_state_check CHECK (lifecycle_state IN ('draft','active','closed'))");
        DB::statement('ALTER TABLE contracts ADD CONSTRAINT contracts_period_check CHECK (effective_to IS NULL OR effective_to > effective_from)');
        DB::statement("CREATE UNIQUE INDEX contracts_one_open_per_employment ON contracts (employment_id) WHERE lifecycle_state IN ('draft','active')");
        DB::statement(<<<'SQL'
            CREATE OR REPLACE FUNCTION contracts_signed_terms_immutable() RETURNS trigger AS $fn$
            BEGIN
                IF OLD.lifecycle_state = 'active' AND (NEW.terms_summary <> OLD.terms_summary OR NEW.signed_ref <> OLD.signed_ref OR NEW.effective_from <> OLD.effective_from) THEN
                    RAISE EXCEPTION 'signed contract terms are immutable once active; a change is a new contract';
                END IF;
                RETURN NEW;
            END;
            $fn$ LANGUAGE plpgsql;
            SQL);
        DB::statement('CREATE TRIGGER contracts_signed_terms_immutable_trigger BEFORE UPDATE ON contracts FOR EACH ROW EXECUTE FUNCTION contracts_signed_terms_immutable()');
        DB::statement(<<<'SQL'
            CREATE OR REPLACE FUNCTION contracts_no_delete() RETURNS trigger AS $fn$
            BEGIN
                RAISE EXCEPTION 'contracts are retained history and cannot be deleted';
            END;
            $fn$ LANGUAGE plpgsql;
            SQL);
        DB::statement('CREATE TRIGGER contracts_no_delete_trigger BEFORE DELETE ON contracts FOR EACH ROW EXECUTE FUNCTION contracts_no_delete()');
    }

    public function down(): void
    {
        DB::statement('DROP TRIGGER IF EXISTS contracts_no_delete_trigger ON contracts');
        DB::statement('DROP FUNCTION IF EXISTS contracts_no_delete()');
        DB::statement('DROP TRIGGER IF EXISTS contracts_signed_terms_immutable_trigger ON contracts');
        DB::statement('DROP FUNCTION IF EXISTS contracts_signed_terms_immutable()');
        Schema::dropIfExists('contracts');
    }
};
