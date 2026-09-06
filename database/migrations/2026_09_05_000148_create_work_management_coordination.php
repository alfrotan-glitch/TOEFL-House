<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Schema;

/**
 * Work Management owns coordination instances and actionable work items only.
 * Domain approvals, exceptions, enrollment, payroll, and finance facts stay
 * in their owning tables and are referenced polymorphically by source ID.
 */
return new class extends Migration
{
    public function up(): void
    {
        Schema::create('workflow_instances', function (Blueprint $table): void {
            $table->char('id', 36)->primary();
            $table->string('definition_key');
            $table->unsignedInteger('definition_version');
            $table->string('source_type');
            // Source IDs follow the polymorphic domain-event contract and
            // may be UUIDs or governed natural keys.
            $table->string('source_id');
            $table->char('source_event_id', 36)->nullable();
            $table->string('correlation_id');
            $table->char('branch_id', 36)->nullable();
            $table->string('lifecycle_state');
            $table->char('started_by', 36);
            $table->timestampTz('started_at');
            $table->timestampTz('closed_at')->nullable();
            $table->jsonb('context')->nullable();
            $table->timestamps();
            $table->foreign('source_event_id')->references('id')->on('domain_events');
            $table->foreign('branch_id')->references('id')->on('branches');
            $table->foreign('started_by')->references('id')->on('people');
            $table->unique(['source_event_id']);
            $table->unique(['definition_key', 'source_type', 'source_id', 'lifecycle_state']);
            $table->index(['source_type', 'source_id']);
        });
        DB::statement("ALTER TABLE workflow_instances ADD CONSTRAINT workflow_instances_state_check CHECK (lifecycle_state IN ('running','completed','cancelled','failed'))");

        Schema::create('work_items', function (Blueprint $table): void {
            $table->char('id', 36)->primary();
            $table->char('workflow_instance_id', 36)->nullable();
            $table->string('kind');
            $table->string('title');
            $table->text('description')->nullable();
            $table->string('source_type');
            // Keep the same polymorphic source identity as the workflow.
            $table->string('source_id');
            $table->string('action_key');
            $table->unsignedInteger('source_version')->nullable();
            $table->char('branch_id', 36)->nullable();
            $table->char('assigned_to', 36)->nullable();
            $table->string('queue_key')->nullable();
            $table->unsignedSmallInteger('priority')->default(100);
            $table->timestampTz('due_at')->nullable();
            $table->string('lifecycle_state');
            $table->timestampTz('claimed_at')->nullable();
            $table->timestampTz('completed_at')->nullable();
            $table->char('completed_by', 36)->nullable();
            $table->char('created_by', 36);
            $table->timestamps();
            $table->foreign('workflow_instance_id')->references('id')->on('workflow_instances');
            $table->foreign('branch_id')->references('id')->on('branches');
            $table->foreign('assigned_to')->references('id')->on('people');
            $table->foreign('completed_by')->references('id')->on('people');
            $table->foreign('created_by')->references('id')->on('people');
            $table->index(['assigned_to', 'lifecycle_state', 'due_at']);
            $table->index(['branch_id', 'lifecycle_state']);
            $table->index(['source_type', 'source_id']);
        });
        DB::statement("ALTER TABLE work_items ADD CONSTRAINT work_items_kind_check CHECK (kind IN ('task','approval','exception'))");
        DB::statement("ALTER TABLE work_items ADD CONSTRAINT work_items_state_check CHECK (lifecycle_state IN ('open','claimed','in_progress','completed','cancelled','expired'))");
        DB::statement("ALTER TABLE work_items ADD CONSTRAINT work_items_assignment_check CHECK (assigned_to IS NOT NULL OR queue_key IS NOT NULL)");
        DB::statement(<<<'SQL'
            CREATE OR REPLACE FUNCTION work_items_provenance_guard() RETURNS trigger AS $fn$
            DECLARE
                workflow_branch char(36);
            BEGIN
                IF TG_OP = 'INSERT' AND NEW.lifecycle_state <> 'open' THEN
                    RAISE EXCEPTION 'a work item is born open and must transition through the coordination command'
                        USING ERRCODE = 'check_violation';
                END IF;
                IF TG_OP = 'UPDATE' THEN
                    IF OLD.workflow_instance_id IS DISTINCT FROM NEW.workflow_instance_id
                       OR OLD.kind IS DISTINCT FROM NEW.kind
                       OR OLD.title IS DISTINCT FROM NEW.title
                       OR OLD.description IS DISTINCT FROM NEW.description
                       OR OLD.source_type IS DISTINCT FROM NEW.source_type
                       OR OLD.source_id IS DISTINCT FROM NEW.source_id
                       OR OLD.action_key IS DISTINCT FROM NEW.action_key
                       OR OLD.source_version IS DISTINCT FROM NEW.source_version
                       OR OLD.branch_id IS DISTINCT FROM NEW.branch_id
                       OR OLD.created_by IS DISTINCT FROM NEW.created_by THEN
                        RAISE EXCEPTION 'work item source and provenance terms are immutable'
                            USING ERRCODE = 'check_violation';
                    END IF;
                    IF OLD.lifecycle_state IS DISTINCT FROM NEW.lifecycle_state
                       AND NOT (
                           (OLD.lifecycle_state = 'open' AND NEW.lifecycle_state IN ('claimed', 'in_progress', 'cancelled', 'expired'))
                           OR (OLD.lifecycle_state = 'open' AND NEW.lifecycle_state = 'completed'
                               AND COALESCE(current_setting('app.work_item_source_completion', true), '') = 'on')
                           OR (OLD.lifecycle_state = 'claimed' AND NEW.lifecycle_state IN ('in_progress', 'completed', 'cancelled', 'expired'))
                           OR (OLD.lifecycle_state = 'in_progress' AND NEW.lifecycle_state IN ('completed', 'cancelled', 'expired'))
                       ) THEN
                        RAISE EXCEPTION 'work item lifecycle transition is not governed'
                            USING ERRCODE = 'check_violation';
                    END IF;
                END IF;
                IF NEW.lifecycle_state IN ('completed', 'cancelled', 'expired')
                   AND (NEW.completed_at IS NULL OR NEW.completed_by IS NULL) THEN
                    RAISE EXCEPTION 'terminal work items require completion evidence'
                        USING ERRCODE = 'check_violation';
                END IF;
                IF NEW.lifecycle_state IN ('open', 'claimed', 'in_progress')
                   AND (NEW.completed_at IS NOT NULL OR NEW.completed_by IS NOT NULL) THEN
                    RAISE EXCEPTION 'non-terminal work items cannot carry completion evidence'
                        USING ERRCODE = 'check_violation';
                END IF;
                IF NEW.workflow_instance_id IS NOT NULL THEN
                    SELECT branch_id INTO workflow_branch
                      FROM workflow_instances WHERE id = NEW.workflow_instance_id;
                    IF NOT FOUND OR workflow_branch IS DISTINCT FROM NEW.branch_id THEN
                        RAISE EXCEPTION 'work item branch provenance must match its workflow instance'
                            USING ERRCODE = 'check_violation';
                    END IF;
                END IF;
                RETURN NEW;
            END;
            $fn$ LANGUAGE plpgsql;
            SQL);
        DB::statement('CREATE TRIGGER work_items_provenance_trigger BEFORE INSERT OR UPDATE ON work_items FOR EACH ROW EXECUTE FUNCTION work_items_provenance_guard()');

        Schema::create('work_item_history', function (Blueprint $table): void {
            $table->char('id', 36)->primary();
            $table->char('workflow_instance_id', 36)->nullable();
            $table->char('work_item_id', 36);
            $table->string('event_type');
            $table->char('actor_id', 36);
            $table->string('from_state')->nullable();
            $table->string('to_state')->nullable();
            $table->jsonb('metadata')->nullable();
            $table->timestampTz('occurred_at');
            $table->foreign('workflow_instance_id')->references('id')->on('workflow_instances');
            $table->foreign('work_item_id')->references('id')->on('work_items');
            $table->foreign('actor_id')->references('id')->on('people');
            $table->index(['work_item_id', 'occurred_at']);
        });
        DB::statement(<<<'SQL'
            CREATE OR REPLACE FUNCTION work_item_history_provenance_guard() RETURNS trigger AS $fn$
            DECLARE
                item_workflow char(36);
            BEGIN
                SELECT workflow_instance_id INTO item_workflow
                  FROM work_items WHERE id = NEW.work_item_id;
                IF NOT FOUND OR item_workflow IS DISTINCT FROM NEW.workflow_instance_id THEN
                    RAISE EXCEPTION 'work item history workflow provenance must match its work item'
                        USING ERRCODE = 'check_violation';
                END IF;
                RETURN NEW;
            END;
            $fn$ LANGUAGE plpgsql;
            SQL);
        DB::statement('CREATE TRIGGER work_item_history_provenance_trigger BEFORE INSERT ON work_item_history FOR EACH ROW EXECUTE FUNCTION work_item_history_provenance_guard()');
        DB::statement(<<<'SQL'
            CREATE OR REPLACE FUNCTION work_item_history_append_only() RETURNS trigger AS $fn$
            BEGIN
                IF TG_OP <> 'INSERT' THEN
                    RAISE EXCEPTION 'work item history is append-only' USING ERRCODE = 'check_violation';
                END IF;
                RETURN NEW;
            END;
            $fn$ LANGUAGE plpgsql;
            SQL);
        DB::statement('CREATE TRIGGER work_item_history_append_only_trigger BEFORE UPDATE OR DELETE ON work_item_history FOR EACH ROW EXECUTE FUNCTION work_item_history_append_only()');
    }

    public function down(): void
    {
        DB::statement('DROP TRIGGER IF EXISTS work_item_history_provenance_trigger ON work_item_history');
        DB::statement('DROP FUNCTION IF EXISTS work_item_history_provenance_guard()');
        DB::statement('DROP TRIGGER IF EXISTS work_item_history_append_only_trigger ON work_item_history');
        DB::statement('DROP FUNCTION IF EXISTS work_item_history_append_only()');
        DB::statement('DROP TRIGGER IF EXISTS work_items_provenance_trigger ON work_items');
        DB::statement('DROP FUNCTION IF EXISTS work_items_provenance_guard()');
        Schema::dropIfExists('work_item_history');
        Schema::dropIfExists('work_items');
        Schema::dropIfExists('workflow_instances');
    }
};
