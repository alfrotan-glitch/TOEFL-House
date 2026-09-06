<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Schema;

return new class extends Migration
{
    public function up(): void
    {
        Schema::create('employment_statuses', function (Blueprint $table): void {
            $table->bigIncrements('seq');
            $table->char('id', 36)->primary();
            $table->char('employment_id', 36);
            $table->string('status');
            $table->date('effective_from');
            $table->string('reason');
            $table->char('actor_id', 36);
            $table->timestamps();
            $table->foreign('employment_id')->references('id')->on('employments');
        });
        DB::statement("ALTER TABLE employment_statuses ADD CONSTRAINT employment_statuses_status_check CHECK (status IN ('candidate','active','on_leave','suspended','terminated'))");
        DB::statement(<<<'SQL'
            CREATE OR REPLACE FUNCTION employment_statuses_append_only() RETURNS trigger AS $fn$
            BEGIN
                RAISE EXCEPTION 'employment status history is append-only; the current status is the latest row, corrections append';
            END;
            $fn$ LANGUAGE plpgsql;
            SQL);
        DB::statement('CREATE TRIGGER employment_statuses_append_only_trigger BEFORE UPDATE OR DELETE ON employment_statuses FOR EACH ROW EXECUTE FUNCTION employment_statuses_append_only()');
    }

    public function down(): void
    {
        DB::statement('DROP TRIGGER IF EXISTS employment_statuses_append_only_trigger ON employment_statuses');
        DB::statement('DROP FUNCTION IF EXISTS employment_statuses_append_only()');
        Schema::dropIfExists('employment_statuses');
    }
};
