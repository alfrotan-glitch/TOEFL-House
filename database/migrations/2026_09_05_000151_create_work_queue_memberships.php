<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Schema;

/** Queue membership is explicit, time-bounded authorization for unassigned work claims. */
return new class extends Migration
{
    public function up(): void
    {
        Schema::create('work_queue_memberships', function (Blueprint $table): void {
            $table->char('id', 36)->primary();
            $table->char('actor_id', 36);
            $table->string('queue_key');
            // A null branch is an organization-scoped queue, never a global
            // wildcard. Persist the organization so claim discovery cannot
            // cross organization boundaries.
            $table->char('organization_id', 36);
            $table->char('branch_id', 36)->nullable();
            $table->string('lifecycle_state');
            $table->timestampTz('effective_from');
            $table->timestampTz('effective_to')->nullable();
            $table->char('created_by', 36);
            $table->timestamps();
            $table->foreign('actor_id')->references('id')->on('people');
            $table->foreign('organization_id')->references('id')->on('organizations');
            $table->foreign('branch_id')->references('id')->on('branches');
            $table->foreign('created_by')->references('id')->on('people');
            $table->unique(['actor_id', 'queue_key', 'branch_id']);
            $table->index(['actor_id', 'lifecycle_state', 'effective_from']);
            $table->index(['queue_key', 'organization_id', 'branch_id', 'lifecycle_state']);
        });
        DB::statement("CREATE UNIQUE INDEX work_queue_memberships_global_unique ON work_queue_memberships (actor_id, queue_key, organization_id) WHERE branch_id IS NULL");
        DB::statement("ALTER TABLE work_queue_memberships ADD CONSTRAINT work_queue_memberships_scope_check CHECK (btrim(organization_id) <> '')");
        DB::statement("ALTER TABLE work_queue_memberships ADD CONSTRAINT work_queue_memberships_state_check CHECK (lifecycle_state IN ('active','revoked'))");
        DB::statement("ALTER TABLE work_queue_memberships ADD CONSTRAINT work_queue_memberships_window_check CHECK (effective_to IS NULL OR effective_to > effective_from)");
        DB::statement(<<<'SQL'
            CREATE OR REPLACE FUNCTION work_queue_memberships_provenance_guard() RETURNS trigger AS $fn$
            BEGIN
                IF NOT EXISTS (
                    SELECT 1 FROM organizations
                     WHERE id = NEW.organization_id
                       AND lifecycle_state = 'active'
                ) THEN
                    RAISE EXCEPTION 'queue membership organization provenance must name an active organization'
                        USING ERRCODE = 'check_violation';
                END IF;
                IF NEW.branch_id IS NOT NULL
                   AND NOT EXISTS (
                       SELECT 1
                         FROM campus_assignments ca
                         JOIN branches b ON b.id = ca.branch_id
                         JOIN campuses c ON c.id = ca.campus_id
                        WHERE ca.branch_id = NEW.branch_id
                          AND b.lifecycle_state = 'active'
                          AND ca.effective_from <= CURRENT_DATE AND (ca.effective_to IS NULL OR ca.effective_to > CURRENT_DATE)
                          AND c.organization_id = NEW.organization_id
                          AND c.lifecycle_state = 'active'
                   ) THEN
                    RAISE EXCEPTION 'queue membership branch and organization provenance must identify the same active structure'
                        USING ERRCODE = 'check_violation';
                END IF;
                IF TG_OP = 'UPDATE'
                   AND (OLD.actor_id IS DISTINCT FROM NEW.actor_id
                        OR OLD.queue_key IS DISTINCT FROM NEW.queue_key
                        OR OLD.organization_id IS DISTINCT FROM NEW.organization_id
                        OR OLD.branch_id IS DISTINCT FROM NEW.branch_id) THEN
                    RAISE EXCEPTION 'queue membership identity and provenance are immutable'
                        USING ERRCODE = 'check_violation';
                END IF;
                RETURN NEW;
            END;
            $fn$ LANGUAGE plpgsql;
            SQL);
        DB::statement('CREATE TRIGGER work_queue_memberships_provenance_trigger BEFORE INSERT OR UPDATE ON work_queue_memberships FOR EACH ROW EXECUTE FUNCTION work_queue_memberships_provenance_guard()');
    }

    public function down(): void
    {
        DB::statement('DROP TRIGGER IF EXISTS work_queue_memberships_provenance_trigger ON work_queue_memberships');
        DB::statement('DROP FUNCTION IF EXISTS work_queue_memberships_provenance_guard()');
        DB::statement('DROP INDEX IF EXISTS work_queue_memberships_global_unique');
        Schema::dropIfExists('work_queue_memberships');
    }
};
