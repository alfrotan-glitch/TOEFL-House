<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Schema;

return new class extends Migration
{
    public function up(): void
    {
        Schema::create('funding_sources', function (Blueprint $table): void {
            $table->char('id', 36)->primary();
            $table->string('name');
            $table->string('agreement_ref');
            $table->decimal('committed_amount', 14, 2);
            $table->string('restricted_category')->nullable();
            $table->text('restriction_note')->nullable();
            $table->char('established_by', 36);
            $table->timestamps();
        });
        DB::statement('ALTER TABLE funding_sources ADD CONSTRAINT funding_sources_committed_check CHECK (committed_amount > 0)');
        DB::statement(<<<'SQL'
            CREATE OR REPLACE FUNCTION funding_sources_immutable() RETURNS trigger AS $fn$
            BEGIN
                RAISE EXCEPTION 'funding agreements are immutable; a restriction cannot be reclassified, utilization is derived';
            END;
            $fn$ LANGUAGE plpgsql;
            SQL);
        DB::statement('CREATE TRIGGER funding_sources_immutable_trigger BEFORE UPDATE OR DELETE ON funding_sources FOR EACH ROW EXECUTE FUNCTION funding_sources_immutable()');
    }

    public function down(): void
    {
        DB::statement('DROP TRIGGER IF EXISTS funding_sources_immutable_trigger ON funding_sources');
        DB::statement('DROP FUNCTION IF EXISTS funding_sources_immutable()');
        Schema::dropIfExists('funding_sources');
    }
};
