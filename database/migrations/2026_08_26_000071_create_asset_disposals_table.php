<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Schema;

return new class extends Migration
{
    public function up(): void
    {
        Schema::create('asset_disposals', function (Blueprint $table): void {
            $table->char('id', 36)->primary();
            $table->char('asset_id', 36);
            $table->string('method');
            $table->string('reason');
            $table->date('disposed_on');
            $table->char('requested_by', 36);
            $table->char('approver_one', 36);
            $table->char('approver_two', 36);
            $table->timestamps();
            $table->foreign('asset_id')->references('id')->on('assets');
        });
        DB::statement("ALTER TABLE asset_disposals ADD CONSTRAINT asset_disposals_method_check CHECK (method IN ('sale','scrap','donation'))");
        DB::statement('CREATE UNIQUE INDEX asset_disposals_one_per_asset ON asset_disposals (asset_id)');
        DB::statement(<<<'SQL'
            CREATE OR REPLACE FUNCTION asset_disposals_immutable() RETURNS trigger AS $fn$
            BEGIN
                RAISE EXCEPTION 'asset disposals are immutable approved history';
            END;
            $fn$ LANGUAGE plpgsql;
            SQL);
        DB::statement('CREATE TRIGGER asset_disposals_immutable_trigger BEFORE UPDATE OR DELETE ON asset_disposals FOR EACH ROW EXECUTE FUNCTION asset_disposals_immutable()');
    }

    public function down(): void
    {
        DB::statement('DROP TRIGGER IF EXISTS asset_disposals_immutable_trigger ON asset_disposals');
        DB::statement('DROP FUNCTION IF EXISTS asset_disposals_immutable()');
        Schema::dropIfExists('asset_disposals');
    }
};
