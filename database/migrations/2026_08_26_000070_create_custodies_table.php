<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Schema;

return new class extends Migration
{
    public function up(): void
    {
        Schema::create('custodies', function (Blueprint $table): void {
            $table->char('id', 36)->primary();
            $table->char('asset_id', 36);
            $table->char('custodian_person_id', 36);
            $table->date('assigned_on');
            $table->date('released_on')->nullable();
            $table->char('assigned_by', 36);
            $table->timestamps();
            $table->foreign('asset_id')->references('id')->on('assets');
            $table->foreign('custodian_person_id')->references('id')->on('people');
        });
        DB::statement('CREATE UNIQUE INDEX custodies_one_open_per_asset ON custodies (asset_id) WHERE released_on IS NULL');
        DB::statement(<<<'SQL'
            CREATE OR REPLACE FUNCTION custodies_release_only() RETURNS trigger AS $fn$
            BEGIN
                IF OLD.released_on IS NOT NULL OR (NEW.asset_id <> OLD.asset_id OR NEW.custodian_person_id <> OLD.custodian_person_id OR NEW.assigned_on <> OLD.assigned_on OR NEW.assigned_by <> OLD.assigned_by) THEN
                    RAISE EXCEPTION 'custody history is retained; an open custody can only be released';
                END IF;
                RETURN NEW;
            END;
            $fn$ LANGUAGE plpgsql;
            SQL);
        DB::statement('CREATE TRIGGER custodies_release_only_trigger BEFORE UPDATE ON custodies FOR EACH ROW EXECUTE FUNCTION custodies_release_only()');
        DB::statement(<<<'SQL'
            CREATE OR REPLACE FUNCTION custodies_no_delete() RETURNS trigger AS $fn$
            BEGIN
                RAISE EXCEPTION 'custody history cannot be deleted';
            END;
            $fn$ LANGUAGE plpgsql;
            SQL);
        DB::statement('CREATE TRIGGER custodies_no_delete_trigger BEFORE DELETE ON custodies FOR EACH ROW EXECUTE FUNCTION custodies_no_delete()');
    }

    public function down(): void
    {
        DB::statement('DROP TRIGGER IF EXISTS custodies_no_delete_trigger ON custodies');
        DB::statement('DROP FUNCTION IF EXISTS custodies_no_delete()');
        DB::statement('DROP TRIGGER IF EXISTS custodies_release_only_trigger ON custodies');
        DB::statement('DROP FUNCTION IF EXISTS custodies_release_only()');
        Schema::dropIfExists('custodies');
    }
};
