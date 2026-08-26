<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Schema;

return new class extends Migration
{
    public function up(): void
    {
        Schema::create('opening_materializations', function (Blueprint $table): void {
            $table->char('id', 36)->primary();
            $table->char('opening_entry_id', 36);
            $table->string('instrument_type');
            $table->char('instrument_id', 36);
            $table->timestamps();
            $table->foreign('opening_entry_id')->references('id')->on('opening_entries');
        });
        DB::statement("ALTER TABLE opening_materializations ADD CONSTRAINT opening_materializations_type_check CHECK (instrument_type IN ('obligation','journal'))");
        DB::statement('CREATE UNIQUE INDEX opening_materializations_one_per_entry ON opening_materializations (opening_entry_id, instrument_type)');
        DB::statement(<<<'SQL'
            CREATE OR REPLACE FUNCTION opening_materializations_retained() RETURNS trigger AS $fn$
            BEGIN
                RAISE EXCEPTION 'opening materialization history is retained';
            END;
            $fn$ LANGUAGE plpgsql;
            SQL);
        DB::statement('CREATE TRIGGER opening_materializations_retained_trigger BEFORE UPDATE OR DELETE ON opening_materializations FOR EACH ROW EXECUTE FUNCTION opening_materializations_retained()');
    }

    public function down(): void
    {
        DB::statement('DROP TRIGGER IF EXISTS opening_materializations_retained_trigger ON opening_materializations');
        DB::statement('DROP FUNCTION IF EXISTS opening_materializations_retained()');
        Schema::dropIfExists('opening_materializations');
    }
};
