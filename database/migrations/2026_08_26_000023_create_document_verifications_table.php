<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Schema;

return new class extends Migration
{
    public function up(): void
    {
        Schema::create('document_verifications', function (Blueprint $table): void {
            $table->char('id', 36)->primary();
            $table->char('document_id', 36);
            $table->integer('version_no');
            $table->char('verifier_person_id', 36);
            $table->string('result');
            $table->string('reason');
            $table->timestamps();
            $table->foreign('document_id')->references('id')->on('documents');
        });
        DB::statement("ALTER TABLE document_verifications ADD CONSTRAINT document_verifications_result_check CHECK (result IN ('pass','fail'))");
        DB::statement(<<<'SQL'
            CREATE OR REPLACE FUNCTION document_verifications_append_only() RETURNS trigger AS $fn$
            BEGIN
                RAISE EXCEPTION 'document_verifications is append-only';
            END;
            $fn$ LANGUAGE plpgsql;
            SQL);
        DB::statement('CREATE TRIGGER document_verifications_append_only_trigger BEFORE UPDATE OR DELETE ON document_verifications FOR EACH ROW EXECUTE FUNCTION document_verifications_append_only()');
    }

    public function down(): void
    {
        DB::statement('DROP TRIGGER IF EXISTS document_verifications_append_only_trigger ON document_verifications');
        DB::statement('DROP FUNCTION IF EXISTS document_verifications_append_only()');
        Schema::dropIfExists('document_verifications');
    }
};
