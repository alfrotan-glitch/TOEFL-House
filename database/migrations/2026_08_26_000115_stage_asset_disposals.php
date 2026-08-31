<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Support\Facades\DB;

/**
 * Staged asset disposal (PHASE_3 increment E) — the three-actor
 * material-action rule becomes three sessions, matching the staged
 * pattern the architecture already uses for refunds (000110), admissions
 * (000111), settlements (000112), assessment corrections (000113) and
 * organization-wide data exports (000114):
 *
 *   - a REQUESTER session (holding resources.dispose_request) requests
 *     disposal of an in-service asset by a known method with a stated
 *     reason — the request is born 'requested';
 *   - two DISTINCT approver sessions (each holding
 *     resources.dispose_approve, each in its own authenticated session,
 *     each distinct from the requester) sign the request — the first
 *     fills approver_one, the second (a different person) fills
 *     approver_two and closes the request as 'approved';
 *   - the disposal is EXECUTED only from 'approved', by the requesting
 *     session; execution closes any open custody, flips the asset to
 *     disposed, records the immutable asset_disposal row, and closes
 *     the request as 'completed'.
 *
 * The command previously received both approvers' identities in a
 * single request, which voided the SoD it enforced on the stored
 * identities. With staging, each signature is captured in its own
 * authenticated session and the boundary re-checks distinctness.
 *
 * Schema: asset_disposal_requests with lifecycle_state ('requested' |
 * 'approved' | 'completed'). The asset_disposal_requests_guard
 * consolidates the boundary rules:
 *
 *   - INSERT: a request is born 'requested', with no approver, executor
 *     or disposal recorded, and a non-empty method and reason;
 *   - UPDATE: requested -> approved (both approvers set and distinct)
 *     and approved -> completed (executor + disposal recorded);
 *     approver slots are written once, never rewritten; no other field
 *     changes;
 *   - DELETE: never (a disposal request is an auditable fact).
 */
return new class extends Migration
{
    public function up(): void
    {
        DB::statement(<<<'SQL'
            CREATE TABLE asset_disposal_requests (
                id character(36) PRIMARY KEY,
                asset_id character(36) NOT NULL REFERENCES assets (id),
                method character varying NOT NULL,
                reason character varying NOT NULL,
                lifecycle_state character varying NOT NULL DEFAULT 'requested',
                requested_by character(36) NOT NULL,
                approver_one_id character(36),
                approver_two_id character(36),
                executed_by character(36),
                disposal_id character(36) REFERENCES asset_disposals (id),
                created_at timestamptz NOT NULL,
                updated_at timestamptz NOT NULL
            )
            SQL);
        DB::statement("ALTER TABLE asset_disposal_requests ADD CONSTRAINT asset_disposal_requests_method_check CHECK (method IN ('sale', 'scrap', 'donation'))");
        DB::statement('ALTER TABLE asset_disposal_requests ADD CONSTRAINT asset_disposal_requests_reason_check CHECK (char_length(reason) > 0)');
        DB::statement("ALTER TABLE asset_disposal_requests ADD CONSTRAINT asset_disposal_requests_lifecycle_state_check CHECK (lifecycle_state IN ('requested', 'approved', 'completed'))");
        DB::statement('CREATE INDEX asset_disposal_requests_asset_index ON asset_disposal_requests (asset_id)');
        DB::statement('CREATE INDEX asset_disposal_requests_lifecycle_index ON asset_disposal_requests (lifecycle_state)');

        DB::statement(<<<'SQL'
            CREATE OR REPLACE FUNCTION asset_disposal_requests_guard() RETURNS trigger AS $fn$
            BEGIN
                IF TG_OP = 'DELETE' THEN
                    RAISE EXCEPTION 'asset disposal requests are auditable facts and cannot be deleted'
                        USING ERRCODE = 'check_violation';
                END IF;

                IF TG_OP = 'INSERT' THEN
                    IF NEW.lifecycle_state <> 'requested' THEN
                        RAISE EXCEPTION 'an asset disposal request is born requested; only approval and execution change it (state: %)', NEW.lifecycle_state
                            USING ERRCODE = 'check_violation';
                    END IF;

                    IF NEW.approver_one_id IS NOT NULL OR NEW.approver_two_id IS NOT NULL
                        OR NEW.executed_by IS NOT NULL OR NEW.disposal_id IS NOT NULL
                    THEN
                        RAISE EXCEPTION 'an asset disposal request is born without approvers, executor or disposal'
                            USING ERRCODE = 'check_violation';
                    END IF;

                    RETURN NEW;
                END IF;

                -- UPDATE
                IF OLD.lifecycle_state = 'completed' THEN
                    RAISE EXCEPTION 'a completed asset disposal request is closed'
                        USING ERRCODE = 'check_violation';
                END IF;

                IF OLD.lifecycle_state = 'requested' AND NEW.lifecycle_state = 'requested' THEN
                    -- The first signature: only the first approver slot may
                    -- be filled while the request stays requested.
                    IF OLD.approver_one_id IS NOT NULL OR NEW.approver_one_id IS NULL
                        OR NEW.approver_two_id IS NOT NULL
                    THEN
                        RAISE EXCEPTION 'a requested asset disposal request accepts only its first approver signature'
                            USING ERRCODE = 'check_violation';
                    END IF;
                ELSIF OLD.lifecycle_state = 'requested' AND NEW.lifecycle_state = 'approved' THEN
                    IF NEW.approver_one_id IS NULL OR NEW.approver_two_id IS NULL THEN
                        RAISE EXCEPTION 'an approved asset disposal request carries two distinct approvers'
                            USING ERRCODE = 'check_violation';
                    END IF;
                    IF trim(NEW.approver_one_id) = trim(NEW.approver_two_id) THEN
                        RAISE EXCEPTION 'an asset disposal needs two distinct approvers'
                            USING ERRCODE = 'check_violation';
                    END IF;
                    IF NEW.executed_by IS NOT NULL OR NEW.disposal_id IS NOT NULL THEN
                        RAISE EXCEPTION 'an approved asset disposal request is not yet executed'
                            USING ERRCODE = 'check_violation';
                    END IF;
                ELSIF OLD.lifecycle_state = 'approved' AND NEW.lifecycle_state = 'completed' THEN
                    IF NEW.executed_by IS NULL OR NEW.disposal_id IS NULL THEN
                        RAISE EXCEPTION 'executing an asset disposal request records the executor and the disposal'
                            USING ERRCODE = 'check_violation';
                    END IF;
                ELSE
                    RAISE EXCEPTION 'an asset disposal request moves only requested -> approved -> completed (state: % -> %)',
                        OLD.lifecycle_state, NEW.lifecycle_state
                        USING ERRCODE = 'check_violation';
                END IF;

                IF NEW.approver_one_id IS DISTINCT FROM OLD.approver_one_id
                    AND OLD.approver_one_id IS NOT NULL
                THEN
                    RAISE EXCEPTION 'an approver slot on an asset disposal request is written once'
                        USING ERRCODE = 'check_violation';
                END IF;
                IF NEW.approver_two_id IS DISTINCT FROM OLD.approver_two_id
                    AND OLD.approver_two_id IS NOT NULL
                THEN
                    RAISE EXCEPTION 'an approver slot on an asset disposal request is written once'
                        USING ERRCODE = 'check_violation';
                END IF;

                IF NEW.asset_id IS DISTINCT FROM OLD.asset_id
                    OR NEW.method IS DISTINCT FROM OLD.method
                    OR NEW.reason IS DISTINCT FROM OLD.reason
                    OR NEW.requested_by IS DISTINCT FROM OLD.requested_by
                    OR NEW.created_at IS DISTINCT FROM OLD.created_at
                THEN
                    RAISE EXCEPTION 'only the lifecycle state, approver slots, executor and disposal may change on an asset disposal request'
                        USING ERRCODE = 'check_violation';
                END IF;

                RETURN NEW;
            END;
            $fn$ LANGUAGE plpgsql;
            SQL);
        DB::statement('CREATE TRIGGER asset_disposal_requests_guard_trigger BEFORE INSERT OR UPDATE OR DELETE ON asset_disposal_requests FOR EACH ROW EXECUTE FUNCTION asset_disposal_requests_guard()');
    }

    public function down(): void
    {
        DB::statement('DROP TRIGGER IF EXISTS asset_disposal_requests_guard_trigger ON asset_disposal_requests');
        DB::statement('DROP FUNCTION IF EXISTS asset_disposal_requests_guard()');
        DB::statement('DROP INDEX IF EXISTS asset_disposal_requests_lifecycle_index');
        DB::statement('DROP INDEX IF EXISTS asset_disposal_requests_asset_index');
        DB::statement('DROP TABLE IF EXISTS asset_disposal_requests');
    }
};
