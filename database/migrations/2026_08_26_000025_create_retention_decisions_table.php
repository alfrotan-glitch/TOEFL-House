<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Schema;

return new class extends Migration
{
    public function up(): void
    {
        Schema::create('retention_decisions', function (Blueprint $table): void {
            $table->char('id', 36)->primary();
            $table->char('document_id', 36);
            $table->char('rule_id', 36);
            $table->string('action');
            $table->string('basis');
            $table->char('decided_by', 36);
            $table->timestamps();
            $table->foreign('document_id')->references('id')->on('documents');
            $table->foreign('rule_id')->references('id')->on('retention_rules');
        });
        DB::statement("ALTER TABLE retention_decisions ADD CONSTRAINT retention_decisions_action_check CHECK (action IN ('retain','archive'))");
        DB::statement(<<<'SQL'
            CREATE OR REPLACE FUNCTION retention_decisions_append_only() RETURNS trigger AS $fn$
            BEGIN
                RAISE EXCEPTION 'retention_decisions is append-only';
            END;
            $fn$ LANGUAGE plpgsql;
            SQL);
        DB::statement('CREATE TRIGGER retention_decisions_append_only_trigger BEFORE UPDATE OR DELETE ON retention_decisions FOR EACH ROW EXECUTE FUNCTION retention_decisions_append_only()');
    }

    public function down(): void
    {
        DB::statement('DROP TRIGGER IF EXISTS retention_decisions_append_only_trigger ON retention_decisions');
        DB::statement('DROP FUNCTION IF EXISTS retention_decisions_append_only()');
        Schema::dropIfExists('retention_decisions');
    }
};
