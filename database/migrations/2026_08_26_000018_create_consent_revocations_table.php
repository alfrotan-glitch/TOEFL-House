<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Schema;

return new class extends Migration
{
    public function up(): void
    {
        Schema::create('consent_revocations', function (Blueprint $table): void {
            $table->char('id', 36)->primary();
            $table->char('consent_id', 36);
            $table->char('revoked_by', 36);
            $table->string('scope');
            $table->string('effect');
            $table->timestamps();
            $table->foreign('consent_id')->references('id')->on('consents');
        });
        DB::statement(<<<'SQL'
            CREATE OR REPLACE FUNCTION consent_revocations_append_only() RETURNS trigger AS $fn$
            BEGIN
                RAISE EXCEPTION 'consent_revocations is append-only';
            END;
            $fn$ LANGUAGE plpgsql;
            SQL);
        DB::statement('CREATE TRIGGER consent_revocations_append_only_trigger BEFORE UPDATE OR DELETE ON consent_revocations FOR EACH ROW EXECUTE FUNCTION consent_revocations_append_only()');
    }

    public function down(): void
    {
        DB::statement('DROP TRIGGER IF EXISTS consent_revocations_append_only_trigger ON consent_revocations');
        DB::statement('DROP FUNCTION IF EXISTS consent_revocations_append_only()');
        Schema::dropIfExists('consent_revocations');
    }
};
