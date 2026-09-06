<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Schema;

return new class extends Migration
{
    public function up(): void
    {
        Schema::create('audit_events', function (Blueprint $table): void {
            $table->char('id', 36)->primary();
            $table->char('actor_id', 36);
            $table->string('operation');
            $table->string('target_type');
            $table->char('target_id', 36);
            $table->string('correlation_id');
            $table->jsonb('before_state')->nullable();
            $table->jsonb('after_state')->nullable();
            $table->timestamp('occurred_at');
            $table->index(['target_type', 'target_id']);
            $table->index('correlation_id');
        });
        DB::statement(<<<'SQL'
            CREATE OR REPLACE FUNCTION audit_events_append_only() RETURNS trigger AS $fn$
            BEGIN
                RAISE EXCEPTION 'audit_events is append-only';
            END;
            $fn$ LANGUAGE plpgsql
        SQL);
        DB::statement('CREATE TRIGGER audit_events_append_only_trigger BEFORE UPDATE OR DELETE ON audit_events FOR EACH ROW EXECUTE FUNCTION audit_events_append_only()');
    }

    public function down(): void
    {
        DB::statement('DROP TRIGGER IF EXISTS audit_events_append_only_trigger ON audit_events');
        DB::statement('DROP FUNCTION IF EXISTS audit_events_append_only()');
        Schema::dropIfExists('audit_events');
    }
};
