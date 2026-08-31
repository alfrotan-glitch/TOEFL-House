<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Support\Facades\DB;

/**
 * Staged organization-wide scope grants (PHASE_3 increment E) — the
 * two-approver SoD for organization-wide authority becomes two sessions,
 * matching the staged pattern the architecture already uses for refunds
 * (000110), admissions (000111), settlements (000112), assessment
 * corrections (000113), organization-wide data exports (000114) and asset
 * disposals (000115):
 *
 *   - a GRANTOR session (holding access.grant for the organization
 *     scope) requests a named-scope permission for a known person with a
 *     stated effective period (emergency grants dated, limited, and
 *     flagged) — the request is born 'requested';
 *   - two DISTINCT approver sessions (each holding
 *     access.approve_org_wide for the organization scope, each in its own
 *     authenticated session) sign the request — the first fills
 *     approver_one, the second (a different person) fills approver_two
 *     and closes the request as 'approved';
 *   - the grant is EXECUTED only from 'approved'; execution records the
 *     immutable scope_grant row (the authority itself) and closes the
 *     request as 'granted'.
 *
 * The command previously received both approvers' identities in a single
 * request, which voided the SoD it enforced on the stored identities.
 * With staging, each signature is captured in its own authenticated
 * session and the boundary re-checks distinctness.
 *
 * Schema: org_wide_grant_requests with lifecycle_state ('requested' |
 * 'approved' | 'granted'). The org_wide_grant_requests_guard consolidates
 * the boundary rules:
 *
 *   - INSERT: a request is born 'requested', with no approver, grantor
 *     record or grant recorded, and a non-empty permission;
 *   - UPDATE: requested -> approved (both approvers set and distinct)
 *     and approved -> granted (executor + grant recorded); approver slots
 *     are written once, never rewritten; no other field changes;
 *   - DELETE: never (a grant request is an auditable fact).
 */
return new class extends Migration
{
    public function up(): void
    {
        DB::statement(<<<'SQL'
            CREATE TABLE org_wide_grant_requests (
                id character(36) PRIMARY KEY,
                person_id character(36) NOT NULL REFERENCES people (id),
                permission character varying NOT NULL,
                organization_id character(36) NOT NULL,
                is_emergency boolean NOT NULL DEFAULT false,
                effective_from date NOT NULL,
                effective_to date,
                lifecycle_state character varying NOT NULL DEFAULT 'requested',
                requested_by character(36) NOT NULL,
                approver_one_id character(36),
                approver_two_id character(36),
                granted_by character(36),
                grant_id character(36) REFERENCES scope_grants (id),
                created_at timestamptz NOT NULL,
                updated_at timestamptz NOT NULL
            )
            SQL);
        DB::statement('ALTER TABLE org_wide_grant_requests ADD CONSTRAINT org_wide_grant_requests_permission_check CHECK (char_length(permission) > 0)');
        DB::statement("ALTER TABLE org_wide_grant_requests ADD CONSTRAINT org_wide_grant_requests_lifecycle_state_check CHECK (lifecycle_state IN ('requested', 'approved', 'granted'))");
        DB::statement('CREATE INDEX org_wide_grant_requests_person_index ON org_wide_grant_requests (person_id)');
        DB::statement('CREATE INDEX org_wide_grant_requests_lifecycle_index ON org_wide_grant_requests (lifecycle_state)');

        DB::statement(<<<'SQL'
            CREATE OR REPLACE FUNCTION org_wide_grant_requests_guard() RETURNS trigger AS $fn$
            BEGIN
                IF TG_OP = 'DELETE' THEN
                    RAISE EXCEPTION 'organization-wide grant requests are auditable facts and cannot be deleted'
                        USING ERRCODE = 'check_violation';
                END IF;

                IF TG_OP = 'INSERT' THEN
                    IF NEW.lifecycle_state <> 'requested' THEN
                        RAISE EXCEPTION 'an organization-wide grant request is born requested; only approval and execution change it (state: %)', NEW.lifecycle_state
                            USING ERRCODE = 'check_violation';
                    END IF;

                    IF NEW.approver_one_id IS NOT NULL OR NEW.approver_two_id IS NOT NULL
                        OR NEW.granted_by IS NOT NULL OR NEW.grant_id IS NOT NULL
                    THEN
                        RAISE EXCEPTION 'an organization-wide grant request is born without approvers, executor or grant'
                            USING ERRCODE = 'check_violation';
                    END IF;

                    RETURN NEW;
                END IF;

                -- UPDATE
                IF OLD.lifecycle_state = 'granted' THEN
                    RAISE EXCEPTION 'an executed organization-wide grant request is closed'
                        USING ERRCODE = 'check_violation';
                END IF;

                IF OLD.lifecycle_state = 'requested' AND NEW.lifecycle_state = 'requested' THEN
                    -- The first signature: only the first approver slot may
                    -- be filled while the request stays requested.
                    IF OLD.approver_one_id IS NOT NULL OR NEW.approver_one_id IS NULL
                        OR NEW.approver_two_id IS NOT NULL
                    THEN
                        RAISE EXCEPTION 'a requested organization-wide grant request accepts only its first approver signature'
                            USING ERRCODE = 'check_violation';
                    END IF;
                ELSIF OLD.lifecycle_state = 'requested' AND NEW.lifecycle_state = 'approved' THEN
                    IF NEW.approver_one_id IS NULL OR NEW.approver_two_id IS NULL THEN
                        RAISE EXCEPTION 'an approved organization-wide grant request carries two distinct approvers'
                            USING ERRCODE = 'check_violation';
                    END IF;
                    IF trim(NEW.approver_one_id) = trim(NEW.approver_two_id) THEN
                        RAISE EXCEPTION 'an organization-wide grant needs two distinct approvers'
                            USING ERRCODE = 'check_violation';
                    END IF;
                    IF NEW.granted_by IS NOT NULL OR NEW.grant_id IS NOT NULL THEN
                        RAISE EXCEPTION 'an approved organization-wide grant request is not yet executed'
                            USING ERRCODE = 'check_violation';
                    END IF;
                ELSIF OLD.lifecycle_state = 'approved' AND NEW.lifecycle_state = 'granted' THEN
                    IF NEW.granted_by IS NULL OR NEW.grant_id IS NULL THEN
                        RAISE EXCEPTION 'executing an organization-wide grant request records the executor and the grant'
                            USING ERRCODE = 'check_violation';
                    END IF;
                ELSE
                    RAISE EXCEPTION 'an organization-wide grant request moves only requested -> approved -> granted (state: % -> %)',
                        OLD.lifecycle_state, NEW.lifecycle_state
                        USING ERRCODE = 'check_violation';
                END IF;

                IF NEW.approver_one_id IS DISTINCT FROM OLD.approver_one_id
                    AND OLD.approver_one_id IS NOT NULL
                THEN
                    RAISE EXCEPTION 'an approver slot on an organization-wide grant request is written once'
                        USING ERRCODE = 'check_violation';
                END IF;
                IF NEW.approver_two_id IS DISTINCT FROM OLD.approver_two_id
                    AND OLD.approver_two_id IS NOT NULL
                THEN
                    RAISE EXCEPTION 'an approver slot on an organization-wide grant request is written once'
                        USING ERRCODE = 'check_violation';
                END IF;

                IF NEW.person_id IS DISTINCT FROM OLD.person_id
                    OR NEW.permission IS DISTINCT FROM OLD.permission
                    OR NEW.organization_id IS DISTINCT FROM OLD.organization_id
                    OR NEW.is_emergency IS DISTINCT FROM OLD.is_emergency
                    OR NEW.effective_from IS DISTINCT FROM OLD.effective_from
                    OR NEW.effective_to IS DISTINCT FROM OLD.effective_to
                    OR NEW.requested_by IS DISTINCT FROM OLD.requested_by
                    OR NEW.created_at IS DISTINCT FROM OLD.created_at
                THEN
                    RAISE EXCEPTION 'only the lifecycle state, approver slots, executor and grant may change on an organization-wide grant request'
                        USING ERRCODE = 'check_violation';
                END IF;

                RETURN NEW;
            END;
            $fn$ LANGUAGE plpgsql;
            SQL);
        DB::statement('CREATE TRIGGER org_wide_grant_requests_guard_trigger BEFORE INSERT OR UPDATE OR DELETE ON org_wide_grant_requests FOR EACH ROW EXECUTE FUNCTION org_wide_grant_requests_guard()');
    }

    public function down(): void
    {
        DB::statement('DROP TRIGGER IF EXISTS org_wide_grant_requests_guard_trigger ON org_wide_grant_requests');
        DB::statement('DROP FUNCTION IF EXISTS org_wide_grant_requests_guard()');
        DB::statement('DROP INDEX IF EXISTS org_wide_grant_requests_lifecycle_index');
        DB::statement('DROP INDEX IF EXISTS org_wide_grant_requests_person_index');
        DB::statement('DROP TABLE IF EXISTS org_wide_grant_requests');
    }
};
