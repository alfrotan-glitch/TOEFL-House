<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Schema;

return new class extends Migration
{
    public function up(): void
    {
        Schema::create('program_versions', function (Blueprint $table): void {
            $table->char('id', 36)->primary();
            $table->char('program_id', 36);
            $table->integer('version_no');
            $table->string('summary');
            $table->timestamps();
            $table->foreign('program_id')->references('id')->on('programs');
            $table->unique(['program_id', 'version_no']);
        });
        DB::statement(<<<'SQL'
            CREATE OR REPLACE FUNCTION program_versions_immutable() RETURNS trigger AS $fn$
            BEGIN
                RAISE EXCEPTION 'published program versions are immutable; publish a new version instead';
            END;
            $fn$ LANGUAGE plpgsql;
            SQL);
        DB::statement('CREATE TRIGGER program_versions_immutable_trigger BEFORE UPDATE OR DELETE ON program_versions FOR EACH ROW EXECUTE FUNCTION program_versions_immutable()');
    }

    public function down(): void
    {
        DB::statement('DROP TRIGGER IF EXISTS program_versions_immutable_trigger ON program_versions');
        DB::statement('DROP FUNCTION IF EXISTS program_versions_immutable()');
        Schema::dropIfExists('program_versions');
    }
};
