<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Schema;

return new class extends Migration
{
    public function up(): void
    {
        Schema::create('inbound_events', function (Blueprint $table): void {
            $table->char('id', 36)->primary();
            $table->char('endpoint_id', 36);
            $table->string('external_id');
            $table->string('event_type');
            $table->jsonb('payload');
            $table->string('payload_digest');
            $table->boolean('signature_verified')->default(false);
            $table->string('status');
            $table->string('error')->nullable();
            $table->timestampTz('processed_at')->nullable();
            $table->char('processed_by', 36)->nullable();
            $table->char('received_by', 36);
            $table->timestamps();
            $table->foreign('endpoint_id')->references('id')->on('integration_endpoints');
        });
        DB::statement("ALTER TABLE inbound_events ADD CONSTRAINT inbound_events_status_check CHECK (status IN ('received','processed','rejected','duplicate'))");
        DB::statement("CREATE UNIQUE INDEX inbound_events_one_accepted_per_external_id ON inbound_events (endpoint_id, external_id) WHERE status <> 'rejected'");
        DB::statement(<<<'SQL'
            CREATE OR REPLACE FUNCTION inbound_events_history_retained() RETURNS trigger AS $fn$
            BEGIN
                IF TG_OP = 'DELETE' THEN
                    RAISE EXCEPTION 'inbound event history cannot be deleted';
                END IF;
                IF NEW.endpoint_id <> OLD.endpoint_id OR NEW.external_id <> OLD.external_id
                    OR NEW.event_type <> OLD.event_type OR NEW.payload::text <> OLD.payload::text
                    OR NEW.payload_digest <> OLD.payload_digest OR NEW.signature_verified <> OLD.signature_verified THEN
                    RAISE EXCEPTION 'an inbound event keeps its identity; only processing status may change';
                END IF;
                IF OLD.status = 'processed' AND NEW.status <> 'processed' THEN
                    RAISE EXCEPTION 'processed inbound events are final';
                END IF;
                RETURN NEW;
            END;
            $fn$ LANGUAGE plpgsql;
            SQL);
        DB::statement('CREATE TRIGGER inbound_events_history_retained_trigger BEFORE UPDATE OR DELETE ON inbound_events FOR EACH ROW EXECUTE FUNCTION inbound_events_history_retained()');
    }

    public function down(): void
    {
        DB::statement('DROP TRIGGER IF EXISTS inbound_events_history_retained_trigger ON inbound_events');
        DB::statement('DROP FUNCTION IF EXISTS inbound_events_history_retained()');
        Schema::dropIfExists('inbound_events');
    }
};
