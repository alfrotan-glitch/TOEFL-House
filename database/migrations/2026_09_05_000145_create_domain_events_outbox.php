<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Schema;

/**
 * Transactional domain-event log. A successful command records one immutable
 * event beside its material fact and audit evidence; endpoint-specific
 * delivery progress remains owned by integration_deliveries.
 */
return new class extends Migration
{
    public function up(): void
    {
        // Used by the insert guard to bind payload_digest to PostgreSQL's
        // canonical jsonb representation.
        DB::statement('CREATE EXTENSION IF NOT EXISTS pgcrypto');

        Schema::create('domain_events', function (Blueprint $table): void {
            $table->char('id', 36)->primary();
            $table->char('audit_event_id', 36)->unique();
            $table->char('actor_id', 36);
            $table->string('event_type');
            $table->unsignedSmallInteger('event_version')->default(1);
            $table->string('aggregate_type');
            // Aggregate IDs mirror the audit target identity and may be a
            // UUID or a governed natural key.
            $table->string('aggregate_id');
            $table->string('correlation_id');
            $table->jsonb('payload');
            $table->string('payload_digest');
            $table->timestampTz('occurred_at');
            $table->timestamps();
            $table->index(['occurred_at', 'id']);
            $table->index(['aggregate_type', 'aggregate_id']);
            $table->foreign('audit_event_id')->references('id')->on('audit_events');
            $table->foreign('actor_id')->references('id')->on('people');
        });
        DB::statement("ALTER TABLE domain_events ADD CONSTRAINT domain_events_identity_check CHECK (event_type <> '' AND aggregate_type <> '' AND aggregate_id <> '' AND correlation_id <> '' AND payload_digest ~ '^[0-9a-f]{64}$' AND jsonb_typeof(payload) = 'object')");
        DB::statement(<<<'SQL'
            CREATE OR REPLACE FUNCTION domain_events_integrity_guard() RETURNS trigger AS $fn$
            DECLARE
                audit_actor char(36);
                audit_operation text;
                audit_target_type text;
                audit_target_id text;
                audit_correlation text;
                audit_before jsonb;
                audit_after jsonb;
            BEGIN
                IF NOT (jsonb_exists(NEW.payload, 'operation') AND jsonb_exists(NEW.payload, 'before') AND jsonb_exists(NEW.payload, 'after'))
                   OR NEW.payload->>'operation' IS DISTINCT FROM NEW.event_type THEN
                    RAISE EXCEPTION 'domain event payload does not contain the recorder envelope'
                        USING ERRCODE = 'check_violation';
                END IF;
                IF NEW.payload_digest <> encode(digest(NEW.payload::text, 'sha256'), 'hex') THEN
                    RAISE EXCEPTION 'domain event payload_digest does not match its stored payload'
                        USING ERRCODE = 'check_violation';
                END IF;

                SELECT actor_id, operation, target_type, target_id, correlation_id, before_state, after_state
                  INTO audit_actor, audit_operation, audit_target_type, audit_target_id, audit_correlation, audit_before, audit_after
                  FROM audit_events
                 WHERE id = NEW.audit_event_id;
                IF audit_actor IS NULL
                   OR NEW.actor_id IS DISTINCT FROM audit_actor
                   OR NEW.event_type IS DISTINCT FROM audit_operation
                   OR NEW.aggregate_type IS DISTINCT FROM audit_target_type
                   OR NEW.aggregate_id IS DISTINCT FROM audit_target_id
                   OR NEW.correlation_id IS DISTINCT FROM audit_correlation
                   OR NULLIF(NEW.payload->'before', 'null'::jsonb) IS DISTINCT FROM audit_before
                   OR NULLIF(NEW.payload->'after', 'null'::jsonb) IS DISTINCT FROM audit_after THEN
                    RAISE EXCEPTION 'domain event envelope does not match its audit event'
                        USING ERRCODE = 'check_violation';
                END IF;

                RETURN NEW;
            END;
            $fn$ LANGUAGE plpgsql;
            SQL);
        DB::statement('CREATE TRIGGER domain_events_integrity_trigger BEFORE INSERT ON domain_events FOR EACH ROW EXECUTE FUNCTION domain_events_integrity_guard()');
        DB::statement(<<<'SQL'
            CREATE OR REPLACE FUNCTION domain_events_append_only() RETURNS trigger AS $fn$
            BEGIN
                IF TG_OP <> 'INSERT' THEN
                    RAISE EXCEPTION 'domain events are immutable append-only facts'
                        USING ERRCODE = 'check_violation';
                END IF;
                RETURN NEW;
            END;
            $fn$ LANGUAGE plpgsql;
            SQL);
        DB::statement('CREATE TRIGGER domain_events_append_only_trigger BEFORE UPDATE OR DELETE ON domain_events FOR EACH ROW EXECUTE FUNCTION domain_events_append_only()');
    }

    public function down(): void
    {
        DB::statement('DROP TRIGGER IF EXISTS domain_events_integrity_trigger ON domain_events');
        DB::statement('DROP FUNCTION IF EXISTS domain_events_integrity_guard()');
        DB::statement('DROP TRIGGER IF EXISTS domain_events_append_only_trigger ON domain_events');
        DB::statement('DROP FUNCTION IF EXISTS domain_events_append_only()');
        Schema::dropIfExists('domain_events');
    }
};
