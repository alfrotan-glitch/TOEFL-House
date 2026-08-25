<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Schema;

return new class extends Migration
{
    public function up(): void
    {
        Schema::create('document_versions', function (Blueprint $table): void {
            $table->char('id', 36)->primary();
            $table->char('document_id', 36);
            $table->integer('version_no');
            $table->string('content_hash');
            $table->string('storage_ref');
            $table->char('uploaded_by', 36);
            $table->timestamps();
            $table->foreign('document_id')->references('id')->on('documents');
            $table->unique(['document_id', 'version_no']);
        });
        DB::statement(<<<'SQL'
            CREATE OR REPLACE FUNCTION document_versions_immutable() RETURNS trigger AS $fn$
            BEGIN
                RAISE EXCEPTION 'document versions are immutable; append a new version instead';
            END;
            $fn$ LANGUAGE plpgsql;
            SQL);
        DB::statement('CREATE TRIGGER document_versions_immutable_trigger BEFORE UPDATE OR DELETE ON document_versions FOR EACH ROW EXECUTE FUNCTION document_versions_immutable()');
    }

    public function down(): void
    {
        DB::statement('DROP TRIGGER IF EXISTS document_versions_immutable_trigger ON document_versions');
        DB::statement('DROP FUNCTION IF EXISTS document_versions_immutable()');
        Schema::dropIfExists('document_versions');
    }
};
