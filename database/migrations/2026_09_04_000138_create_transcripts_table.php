<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Schema;

return new class extends Migration
{
    public function up(): void
    {
        Schema::create('transcripts', function (Blueprint $table): void {
            $table->char('id', 36)->primary();
            $table->char('student_id', 36);
            $table->char('program_version_id', 36);
            // The issued content, frozen at issuance: prints render this
            // payload, never a re-derivation, so later achievements cannot
            // leak into earlier records.
            $table->jsonb('payload');
            $table->string('content_hash', 64);
            // Locator pin to the managed transcript document, set once at
            // INSERT inside the issuance transaction. No FK: the document has
            // its own lifecycle and the immutability trigger forbids drift.
            $table->char('document_id', 36)->nullable()->unique();
            $table->string('issued_by');
            $table->timestamp('issued_at');
            $table->timestamps();
            $table->foreign('student_id')->references('id')->on('students');
            $table->foreign('program_version_id')->references('id')->on('program_versions');
            $table->index(['student_id', 'program_version_id']);
        });
        DB::statement(<<<'SQL'
            CREATE OR REPLACE FUNCTION transcripts_immutable() RETURNS trigger AS $fn$
            BEGIN
                RAISE EXCEPTION 'transcript issuance records are immutable';
            END;
            $fn$ LANGUAGE plpgsql;
            SQL);
        DB::statement('CREATE TRIGGER transcripts_immutable_trigger BEFORE UPDATE OR DELETE ON transcripts FOR EACH ROW EXECUTE FUNCTION transcripts_immutable()');
    }

    public function down(): void
    {
        DB::statement('DROP TRIGGER IF EXISTS transcripts_immutable_trigger ON transcripts');
        DB::statement('DROP FUNCTION IF EXISTS transcripts_immutable()');
        Schema::dropIfExists('transcripts');
    }
};
