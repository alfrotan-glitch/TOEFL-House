<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Schema;

return new class extends Migration
{
    public function up(): void
    {
        Schema::create('reconciliations', function (Blueprint $table): void {
            $table->char('id', 36)->primary();
            $table->char('period_id', 36);
            $table->string('subject');
            $table->decimal('expected', 14, 2);
            $table->decimal('observed', 14, 2);
            $table->decimal('variance', 14, 2);
            $table->text('explanation')->nullable();
            $table->string('lifecycle_state');
            $table->char('observed_by', 36);
            $table->char('approved_by', 36)->nullable();
            $table->timestamps();
            $table->foreign('period_id')->references('id')->on('financial_periods');
        });
        DB::statement("ALTER TABLE reconciliations ADD CONSTRAINT reconciliations_lifecycle_state_check CHECK (lifecycle_state IN ('draft','approved'))");
        DB::statement('ALTER TABLE reconciliations ADD CONSTRAINT reconciliations_variance_check CHECK (variance = observed - expected)');
        DB::statement('CREATE UNIQUE INDEX reconciliations_one_per_period_subject ON reconciliations (period_id, subject)');
        DB::statement(<<<'SQL'
            CREATE OR REPLACE FUNCTION reconciliations_approved_locked() RETURNS trigger AS $fn$
            BEGIN
                IF OLD.lifecycle_state = 'approved' THEN
                    RAISE EXCEPTION 'approved reconciliations are locked variance evidence';
                END IF;
                RETURN NEW;
            END;
            $fn$ LANGUAGE plpgsql;
            SQL);
        DB::statement('CREATE TRIGGER reconciliations_approved_locked_trigger BEFORE UPDATE OR DELETE ON reconciliations FOR EACH ROW EXECUTE FUNCTION reconciliations_approved_locked()');
    }

    public function down(): void
    {
        DB::statement('DROP TRIGGER IF EXISTS reconciliations_approved_locked_trigger ON reconciliations');
        DB::statement('DROP FUNCTION IF EXISTS reconciliations_approved_locked()');
        Schema::dropIfExists('reconciliations');
    }
};
