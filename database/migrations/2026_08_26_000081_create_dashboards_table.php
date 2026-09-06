<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Schema;

return new class extends Migration
{
    public function up(): void
    {
        Schema::create('dashboards', function (Blueprint $table): void {
            $table->char('id', 36)->primary();
            $table->string('name');
            $table->char('created_by', 36);
            $table->timestamps();
        });
        DB::statement('CREATE UNIQUE INDEX dashboards_name_unique ON dashboards (name)');

        Schema::create('dashboard_pins', function (Blueprint $table): void {
            $table->char('id', 36)->primary();
            $table->char('dashboard_id', 36);
            $table->char('metric_id', 36);
            $table->string('period_key');
            $table->string('scope_type');
            $table->char('scope_id', 36)->nullable();
            $table->char('pinned_by', 36);
            $table->timestamps();
            $table->foreign('dashboard_id')->references('id')->on('dashboards');
            $table->foreign('metric_id')->references('id')->on('metric_definitions');
        });
        DB::statement("ALTER TABLE dashboard_pins ADD CONSTRAINT dashboard_pins_scope_type_check CHECK (scope_type IN ('global','student','class','fund'))");
        DB::statement('CREATE UNIQUE INDEX dashboard_pins_one_per_slice ON dashboard_pins (dashboard_id, metric_id, period_key, scope_type, COALESCE(scope_id, \'00000000-0000-0000-0000-000000000000\'))');
        DB::statement(<<<'SQL'
            CREATE OR REPLACE FUNCTION dashboard_pins_immutable() RETURNS trigger AS $fn$
            BEGIN
                RAISE EXCEPTION 'dashboard pins are history; unpin and re-pin instead of rewriting';
            END;
            $fn$ LANGUAGE plpgsql;
            SQL);
        DB::statement('CREATE TRIGGER dashboard_pins_immutable_trigger BEFORE UPDATE OR DELETE ON dashboard_pins FOR EACH ROW EXECUTE FUNCTION dashboard_pins_immutable()');
    }

    public function down(): void
    {
        DB::statement('DROP TRIGGER IF EXISTS dashboard_pins_immutable_trigger ON dashboard_pins');
        DB::statement('DROP FUNCTION IF EXISTS dashboard_pins_immutable()');
        Schema::dropIfExists('dashboard_pins');
        Schema::dropIfExists('dashboards');
    }
};
