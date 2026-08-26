<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Schema;

return new class extends Migration
{
    public function up(): void
    {
        Schema::create('integration_endpoints', function (Blueprint $table): void {
            $table->char('id', 36)->primary();
            $table->string('key');
            $table->string('name');
            $table->string('channel');
            $table->string('contract_version');
            $table->string('credential_ref');
            $table->string('endpoint_ref');
            $table->string('state');
            $table->char('approved_by', 36);
            $table->char('created_by', 36);
            $table->timestamps();
        });
        DB::statement("ALTER TABLE integration_endpoints ADD CONSTRAINT integration_endpoints_channel_check CHECK (channel IN ('sms','email','payment','storage','identity','messaging','export'))");
        DB::statement("ALTER TABLE integration_endpoints ADD CONSTRAINT integration_endpoints_state_check CHECK (state IN ('active','retired'))");
        DB::statement('CREATE UNIQUE INDEX integration_endpoints_key_unique ON integration_endpoints (key)');
        DB::statement(<<<'SQL'
            CREATE OR REPLACE FUNCTION integration_endpoints_retired_immutable() RETURNS trigger AS $fn$
            BEGIN
                IF OLD.state = 'retired' THEN
                    RAISE EXCEPTION 'retired integration endpoints are retained configuration history';
                END IF;
                IF TG_OP = 'DELETE' THEN
                    RAISE EXCEPTION 'integration endpoint history cannot be deleted';
                END IF;
                RETURN NEW;
            END;
            $fn$ LANGUAGE plpgsql;
            SQL);
        DB::statement('CREATE TRIGGER integration_endpoints_retired_immutable_trigger BEFORE UPDATE OR DELETE ON integration_endpoints FOR EACH ROW EXECUTE FUNCTION integration_endpoints_retired_immutable()');
    }

    public function down(): void
    {
        DB::statement('DROP TRIGGER IF EXISTS integration_endpoints_retired_immutable_trigger ON integration_endpoints');
        DB::statement('DROP FUNCTION IF EXISTS integration_endpoints_retired_immutable()');
        Schema::dropIfExists('integration_endpoints');
    }
};
