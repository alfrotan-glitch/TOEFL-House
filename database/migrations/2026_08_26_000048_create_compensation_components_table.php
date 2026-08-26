<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Schema;

return new class extends Migration
{
    public function up(): void
    {
        Schema::create('compensation_components', function (Blueprint $table): void {
            $table->char('id', 36)->primary();
            $table->char('contract_id', 36);
            $table->string('kind');
            $table->decimal('amount', 14, 2);
            $table->date('effective_from');
            $table->date('effective_to')->nullable();
            $table->string('lifecycle_state');
            $table->char('proposed_by', 36);
            $table->char('approved_by', 36)->nullable();
            $table->timestamps();
            $table->foreign('contract_id')->references('id')->on('contracts');
        });
        DB::statement("ALTER TABLE compensation_components ADD CONSTRAINT compensation_components_kind_check CHECK (kind IN ('fixed','hourly','class_based','allowance'))");
        DB::statement("ALTER TABLE compensation_components ADD CONSTRAINT compensation_components_lifecycle_state_check CHECK (lifecycle_state IN ('proposed','active'))");
        DB::statement('ALTER TABLE compensation_components ADD CONSTRAINT compensation_components_amount_check CHECK (amount > 0)');
        DB::statement('ALTER TABLE compensation_components ADD CONSTRAINT compensation_components_period_check CHECK (effective_to IS NULL OR effective_to > effective_from)');
        DB::statement(<<<'SQL'
            CREATE OR REPLACE FUNCTION compensation_components_active_immutable() RETURNS trigger AS $fn$
            BEGIN
                IF OLD.lifecycle_state = 'active' THEN
                    RAISE EXCEPTION 'active compensation components are immutable entitlement history; a change is a new effective-dated component';
                END IF;
                RETURN NEW;
            END;
            $fn$ LANGUAGE plpgsql;
            SQL);
        DB::statement('CREATE TRIGGER compensation_components_active_immutable_trigger BEFORE UPDATE OR DELETE ON compensation_components FOR EACH ROW EXECUTE FUNCTION compensation_components_active_immutable()');
    }

    public function down(): void
    {
        DB::statement('DROP TRIGGER IF EXISTS compensation_components_active_immutable_trigger ON compensation_components');
        DB::statement('DROP FUNCTION IF EXISTS compensation_components_active_immutable()');
        Schema::dropIfExists('compensation_components');
    }
};
