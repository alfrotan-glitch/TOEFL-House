<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Schema;

return new class extends Migration
{
    public function up(): void
    {
        Schema::create('compensation_rules', function (Blueprint $table): void {
            $table->char('id', 36)->primary();
            $table->char('contract_version_id', 36);
            $table->string('method');
            $table->char('skill_id', 36)->nullable();
            $table->char('scale_id', 36)->nullable();
            $table->string('label')->nullable();
            $table->decimal('rate', 14, 2);
            $table->timestamps();
            $table->foreign('contract_version_id')->references('id')->on('contract_versions');
            $table->foreign('skill_id')->references('id')->on('skills');
            $table->foreign('scale_id')->references('id')->on('scales');
        });
        DB::statement("ALTER TABLE compensation_rules ADD CONSTRAINT compensation_rules_method_check CHECK (method IN ('fixed_monthly','allowance','session_rate','hourly_rate'))");
        DB::statement('ALTER TABLE compensation_rules ADD CONSTRAINT compensation_rules_rate_check CHECK (rate > 0)');
        DB::statement(<<<'SQL'
            ALTER TABLE compensation_rules ADD CONSTRAINT compensation_rules_dimension_check CHECK (
                (method IN ('fixed_monthly','allowance') AND skill_id IS NULL AND scale_id IS NULL AND (method <> 'allowance' OR label IS NOT NULL))
                OR (method IN ('session_rate','hourly_rate') AND label IS NULL)
            )
            SQL);
        DB::statement(<<<'SQL'
            CREATE UNIQUE INDEX compensation_rules_one_per_unit_rate_per_version ON compensation_rules (
                contract_version_id,
                COALESCE(skill_id, '00000000-0000-4000-8000-00000000ca11ed'),
                COALESCE(scale_id, '00000000-0000-4000-8000-00000000ca11ed')
            ) WHERE method IN ('session_rate','hourly_rate')
            SQL);
        DB::statement("CREATE UNIQUE INDEX compensation_rules_one_fixed_per_version ON compensation_rules (contract_version_id) WHERE method = 'fixed_monthly'");
        DB::statement("CREATE UNIQUE INDEX compensation_rules_one_allowance_label_per_version ON compensation_rules (contract_version_id, label) WHERE method = 'allowance'");
        DB::statement(<<<'SQL'
            CREATE OR REPLACE FUNCTION compensation_rules_version_gate() RETURNS trigger AS $fn$
            DECLARE version_state text;
            DECLARE rule_version_id char(36);
            BEGIN
                IF TG_OP = 'DELETE' THEN
                    rule_version_id := OLD.contract_version_id;
                ELSE
                    rule_version_id := NEW.contract_version_id;
                END IF;
                SELECT lifecycle_state INTO version_state FROM contract_versions WHERE id = rule_version_id;
                IF TG_OP = 'UPDATE' AND NEW.contract_version_id <> OLD.contract_version_id THEN
                    RAISE EXCEPTION 'a compensation rule cannot migrate between contract versions';
                END IF;
                IF version_state IS DISTINCT FROM 'draft' THEN
                    RAISE EXCEPTION 'compensation rules attach to a draft contract version only and are frozen once it leaves draft';
                END IF;
                IF TG_OP = 'DELETE' THEN
                    RETURN OLD;
                END IF;
                RETURN NEW;
            END;
            $fn$ LANGUAGE plpgsql;
            SQL);
        DB::statement('CREATE TRIGGER compensation_rules_version_gate_trigger BEFORE INSERT OR UPDATE OR DELETE ON compensation_rules FOR EACH ROW EXECUTE FUNCTION compensation_rules_version_gate()');
    }

    public function down(): void
    {
        DB::statement('DROP TRIGGER IF EXISTS compensation_rules_version_gate_trigger ON compensation_rules');
        DB::statement('DROP FUNCTION IF EXISTS compensation_rules_version_gate()');
        Schema::dropIfExists('compensation_rules');
    }
};
