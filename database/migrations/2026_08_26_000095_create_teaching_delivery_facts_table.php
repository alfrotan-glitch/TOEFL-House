<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Schema;

return new class extends Migration
{
    public function up(): void
    {
        Schema::create('teaching_delivery_facts', function (Blueprint $table): void {
            $table->char('id', 36)->primary();
            $table->char('payroll_calculation_id', 36);
            $table->char('session_id', 36);
            $table->char('skill_id', 36);
            $table->date('scheduled_on');
            $table->decimal('hours', 8, 2);
            $table->timestamps();
            $table->foreign('payroll_calculation_id')->references('id')->on('payroll_calculations');
            $table->foreign('session_id')->references('id')->on('class_sessions');
            $table->foreign('skill_id')->references('id')->on('skills');
        });
        DB::statement('CREATE UNIQUE INDEX teaching_delivery_facts_one_per_session ON teaching_delivery_facts (session_id)');
        DB::statement(<<<'SQL'
            CREATE OR REPLACE FUNCTION teaching_delivery_facts_claim() RETURNS trigger AS $fn$
            DECLARE old_state text;
            DECLARE old_period char(36);
            DECLARE old_employment char(36);
            DECLARE new_period char(36);
            DECLARE new_employment char(36);
            BEGIN
                IF TG_OP = 'DELETE' THEN
                    RAISE EXCEPTION 'teaching delivery facts are retained payroll evidence and cannot be deleted';
                END IF;
                IF NEW.session_id <> OLD.session_id OR NEW.skill_id <> OLD.skill_id OR NEW.scheduled_on <> OLD.scheduled_on
                    OR NEW.hours <> OLD.hours OR NEW.created_at <> OLD.created_at THEN
                    RAISE EXCEPTION 'teaching delivery evidence is immutable; only the claiming calculation may migrate';
                END IF;
                IF NEW.payroll_calculation_id = OLD.payroll_calculation_id THEN
                    RETURN NEW;
                END IF;
                SELECT lifecycle_state, period_id, employment_id INTO old_state, old_period, old_employment FROM payroll_calculations WHERE id = OLD.payroll_calculation_id;
                SELECT period_id, employment_id INTO new_period, new_employment FROM payroll_calculations WHERE id = NEW.payroll_calculation_id;
                IF old_state IS DISTINCT FROM 'superseded' OR new_period IS DISTINCT FROM old_period OR new_employment IS DISTINCT FROM old_employment THEN
                    RAISE EXCEPTION 'a delivery claim may migrate only from a superseded calculation of the same period and employment';
                END IF;
                RETURN NEW;
            END;
            $fn$ LANGUAGE plpgsql;
            SQL);
        DB::statement('CREATE TRIGGER teaching_delivery_facts_claim_trigger BEFORE UPDATE OR DELETE ON teaching_delivery_facts FOR EACH ROW EXECUTE FUNCTION teaching_delivery_facts_claim()');
    }

    public function down(): void
    {
        DB::statement('DROP TRIGGER IF EXISTS teaching_delivery_facts_claim_trigger ON teaching_delivery_facts');
        DB::statement('DROP FUNCTION IF EXISTS teaching_delivery_facts_claim()');
        Schema::dropIfExists('teaching_delivery_facts');
    }
};
