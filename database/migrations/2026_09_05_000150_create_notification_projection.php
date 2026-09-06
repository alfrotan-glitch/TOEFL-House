<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Schema;

/** Recipient/read projection distinct from messages, work items, approvals, and source facts. */
return new class extends Migration
{
    public function up(): void
    {
        Schema::create('notifications', function (Blueprint $table): void {
            $table->char('id', 36)->primary();
            $table->char('event_id', 36);
            $table->char('recipient_actor_id', 36);
            $table->string('source_type');
            // Notifications point back to the event aggregate, whose ID may
            // be a UUID or a governed natural key.
            $table->string('source_id');
            $table->string('dedupe_key')->unique();
            $table->string('title');
            $table->string('body_ref')->nullable();
            $table->string('severity');
            $table->string('scope_type');
            $table->char('organization_id', 36)->nullable();
            $table->char('branch_id', 36)->nullable();
            $table->string('lifecycle_state');
            $table->timestampTz('read_at')->nullable();
            $table->timestampTz('dismissed_at')->nullable();
            $table->timestampTz('expires_at')->nullable();
            $table->timestamps();
            $table->foreign('event_id')->references('id')->on('domain_events');
            $table->foreign('recipient_actor_id')->references('id')->on('people');
            $table->foreign('organization_id')->references('id')->on('organizations');
            $table->foreign('branch_id')->references('id')->on('branches');
            $table->index(['recipient_actor_id', 'lifecycle_state', 'created_at']);
            $table->index(['branch_id', 'lifecycle_state']);
            $table->index(['organization_id', 'lifecycle_state']);
        });
        DB::statement("ALTER TABLE notifications ADD CONSTRAINT notifications_severity_check CHECK (severity IN ('info','warning','critical'))");
        DB::statement("ALTER TABLE notifications ADD CONSTRAINT notifications_scope_check CHECK (scope_type IN ('branch','organization') AND ((scope_type = 'branch' AND branch_id IS NOT NULL AND organization_id IS NOT NULL) OR (scope_type = 'organization' AND organization_id IS NOT NULL AND branch_id IS NULL)))");
        DB::statement("ALTER TABLE notifications ADD CONSTRAINT notifications_state_check CHECK (lifecycle_state IN ('unread','read','dismissed'))");
        DB::statement("ALTER TABLE notifications ADD CONSTRAINT notifications_read_state_check CHECK ((lifecycle_state = 'unread' AND read_at IS NULL AND dismissed_at IS NULL) OR (lifecycle_state = 'read' AND read_at IS NOT NULL AND dismissed_at IS NULL) OR (lifecycle_state = 'dismissed' AND dismissed_at IS NOT NULL))");
        DB::statement(<<<'SQL'
            CREATE OR REPLACE FUNCTION notifications_provenance_guard() RETURNS trigger AS $fn$
            BEGIN
                IF NEW.scope_type = 'branch'
                   AND NOT EXISTS (
                       SELECT 1 FROM branches
                        WHERE id = NEW.branch_id
                          AND lifecycle_state = 'active'
                   ) THEN
                    RAISE EXCEPTION 'notification branch provenance must name an active branch'
                        USING ERRCODE = 'check_violation';
                END IF;
                IF NEW.scope_type = 'organization'
                   AND NOT EXISTS (
                       SELECT 1 FROM organizations
                        WHERE id = NEW.organization_id
                          AND lifecycle_state = 'active'
                   ) THEN
                    RAISE EXCEPTION 'notification organization provenance must name an active organization'
                        USING ERRCODE = 'check_violation';
                END IF;
                IF NEW.branch_id IS NOT NULL
                   AND NEW.organization_id IS NOT NULL
                   AND NOT EXISTS (
                       SELECT 1
                         FROM campus_assignments ca
                         JOIN campuses c ON c.id = ca.campus_id
                         JOIN organizations o ON o.id = c.organization_id
                        WHERE ca.branch_id = NEW.branch_id
                          AND ca.effective_from <= CURRENT_DATE AND (ca.effective_to IS NULL OR ca.effective_to > CURRENT_DATE)
                          AND c.organization_id = NEW.organization_id
                          AND c.lifecycle_state = 'active'
                          AND o.lifecycle_state = 'active'
                   ) THEN
                    RAISE EXCEPTION 'notification branch and organization provenance must identify the same active structure'
                        USING ERRCODE = 'check_violation';
                END IF;
                RETURN NEW;
            END;
            $fn$ LANGUAGE plpgsql;
            SQL);
        DB::statement('CREATE TRIGGER notifications_provenance_trigger BEFORE INSERT OR UPDATE OF scope_type, organization_id, branch_id ON notifications FOR EACH ROW EXECUTE FUNCTION notifications_provenance_guard()');
    }

    public function down(): void
    {
        DB::statement('DROP TRIGGER IF EXISTS notifications_provenance_trigger ON notifications');
        DB::statement('DROP FUNCTION IF EXISTS notifications_provenance_guard()');
        DB::statement('ALTER TABLE notifications DROP CONSTRAINT IF EXISTS notifications_read_state_check');
        DB::statement('ALTER TABLE notifications DROP CONSTRAINT IF EXISTS notifications_state_check');
        DB::statement('ALTER TABLE notifications DROP CONSTRAINT IF EXISTS notifications_scope_check');
        DB::statement('ALTER TABLE notifications DROP CONSTRAINT IF EXISTS notifications_severity_check');
        Schema::dropIfExists('notifications');
    }
};
