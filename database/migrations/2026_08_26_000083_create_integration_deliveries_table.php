<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Schema;

return new class extends Migration
{
    public function up(): void
    {
        Schema::create('integration_deliveries', function (Blueprint $table): void {
            $table->char('id', 36)->primary();
            $table->char('endpoint_id', 36);
            $table->string('idempotency_key');
            $table->string('correlation_id');
            $table->string('source_type');
            $table->char('source_id', 36);
            $table->string('contract_action');
            $table->jsonb('payload');
            $table->string('payload_digest');
            $table->string('status');
            $table->integer('attempts')->default(0);
            $table->integer('max_attempts');
            $table->integer('requeues')->default(0);
            $table->timestampTz('next_run_at')->nullable();
            $table->string('last_error')->nullable();
            $table->string('delivered_ref')->nullable();
            $table->timestampTz('delivered_at')->nullable();
            $table->char('created_by', 36);
            $table->timestamps();
            $table->foreign('endpoint_id')->references('id')->on('integration_endpoints');
        });
        DB::statement("ALTER TABLE integration_deliveries ADD CONSTRAINT integration_deliveries_status_check CHECK (status IN ('queued','failed','delivered','dead_letter'))");
        DB::statement('ALTER TABLE integration_deliveries ADD CONSTRAINT integration_deliveries_attempts_check CHECK (attempts >= 0 AND max_attempts BETWEEN 1 AND 10 AND requeues >= 0)');
        DB::statement('ALTER TABLE integration_deliveries ADD CONSTRAINT integration_deliveries_evidence_check CHECK ((status = \'delivered\') = (delivered_ref IS NOT NULL AND delivered_at IS NOT NULL))');
        DB::statement('CREATE UNIQUE INDEX integration_deliveries_one_per_key ON integration_deliveries (endpoint_id, idempotency_key)');
        DB::statement(<<<'SQL'
            CREATE OR REPLACE FUNCTION integration_deliveries_progress_only() RETURNS trigger AS $fn$
            BEGIN
                IF TG_OP = 'DELETE' THEN
                    RAISE EXCEPTION 'delivery history cannot be deleted';
                END IF;
                IF NEW.endpoint_id <> OLD.endpoint_id OR NEW.idempotency_key <> OLD.idempotency_key
                    OR NEW.correlation_id <> OLD.correlation_id OR NEW.source_type <> OLD.source_type
                    OR NEW.source_id <> OLD.source_id OR NEW.contract_action <> OLD.contract_action
                    OR NEW.payload::text <> OLD.payload::text OR NEW.payload_digest <> OLD.payload_digest
                    OR NEW.max_attempts <> OLD.max_attempts OR NEW.created_by <> OLD.created_by THEN
                    RAISE EXCEPTION 'a delivery keeps its identity; only progress may change';
                END IF;
                IF OLD.status = 'delivered' AND NEW.status <> 'delivered' THEN
                    RAISE EXCEPTION 'delivered integrations are final';
                END IF;
                IF OLD.status = 'dead_letter' AND NEW.status NOT IN ('dead_letter','queued') THEN
                    RAISE EXCEPTION 'a dead-lettered delivery leaves review only via an audited requeue';
                END IF;
                RETURN NEW;
            END;
            $fn$ LANGUAGE plpgsql;
            SQL);
        DB::statement('CREATE TRIGGER integration_deliveries_progress_only_trigger BEFORE UPDATE OR DELETE ON integration_deliveries FOR EACH ROW EXECUTE FUNCTION integration_deliveries_progress_only()');
    }

    public function down(): void
    {
        DB::statement('DROP TRIGGER IF EXISTS integration_deliveries_progress_only_trigger ON integration_deliveries');
        DB::statement('DROP FUNCTION IF EXISTS integration_deliveries_progress_only()');
        Schema::dropIfExists('integration_deliveries');
    }
};
