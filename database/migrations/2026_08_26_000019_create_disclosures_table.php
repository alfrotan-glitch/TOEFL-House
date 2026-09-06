<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Schema;

return new class extends Migration
{
    public function up(): void
    {
        Schema::create('disclosures', function (Blueprint $table): void {
            $table->char('id', 36)->primary();
            $table->char('subject_person_id', 36);
            $table->string('recipient');
            $table->string('purpose');
            $table->string('authority');
            $table->string('scope_type');
            $table->char('scope_id', 36);
            $table->string('disclosed_category');
            $table->char('disclosed_by', 36);
            $table->timestamps();
            $table->foreign('subject_person_id')->references('id')->on('people');
        });
        DB::statement("ALTER TABLE disclosures ADD CONSTRAINT disclosures_scope_type_check CHECK (scope_type IN ('organization','campus','branch','department','subject'))");
        DB::statement(<<<'SQL'
            CREATE OR REPLACE FUNCTION disclosures_append_only() RETURNS trigger AS $fn$
            BEGIN
                RAISE EXCEPTION 'disclosures is append-only';
            END;
            $fn$ LANGUAGE plpgsql;
            SQL);
        DB::statement('CREATE TRIGGER disclosures_append_only_trigger BEFORE UPDATE OR DELETE ON disclosures FOR EACH ROW EXECUTE FUNCTION disclosures_append_only()');
    }

    public function down(): void
    {
        DB::statement('DROP TRIGGER IF EXISTS disclosures_append_only_trigger ON disclosures');
        DB::statement('DROP FUNCTION IF EXISTS disclosures_append_only()');
        Schema::dropIfExists('disclosures');
    }
};
