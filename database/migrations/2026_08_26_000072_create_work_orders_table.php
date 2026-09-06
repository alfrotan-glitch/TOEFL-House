<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Schema;

return new class extends Migration
{
    public function up(): void
    {
        Schema::create('work_orders', function (Blueprint $table): void {
            $table->char('id', 36)->primary();
            $table->string('facility_note');
            $table->text('description');
            $table->string('lifecycle_state');
            $table->char('requested_by', 36);
            $table->char('approved_by', 36)->nullable();
            $table->string('evidence_ref')->nullable();
            $table->timestamps();
        });
        DB::statement("ALTER TABLE work_orders ADD CONSTRAINT work_orders_lifecycle_state_check CHECK (lifecycle_state IN ('requested','approved','in_progress','completed','cancelled'))");
        DB::statement(<<<'SQL'
            CREATE OR REPLACE FUNCTION work_orders_terminal_immutable() RETURNS trigger AS $fn$
            BEGIN
                IF OLD.lifecycle_state IN ('completed','cancelled') THEN
                    RAISE EXCEPTION 'completed or cancelled work orders are retained history';
                END IF;
                RETURN NEW;
            END;
            $fn$ LANGUAGE plpgsql;
            SQL);
        DB::statement('CREATE TRIGGER work_orders_terminal_immutable_trigger BEFORE UPDATE OR DELETE ON work_orders FOR EACH ROW EXECUTE FUNCTION work_orders_terminal_immutable()');
    }

    public function down(): void
    {
        DB::statement('DROP TRIGGER IF EXISTS work_orders_terminal_immutable_trigger ON work_orders');
        DB::statement('DROP FUNCTION IF EXISTS work_orders_terminal_immutable()');
        Schema::dropIfExists('work_orders');
    }
};
