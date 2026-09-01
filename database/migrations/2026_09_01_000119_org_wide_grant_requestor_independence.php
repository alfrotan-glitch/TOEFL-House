<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Support\Facades\DB;

/**
 * Org-wide grant Separation-of-Duties hardening (E2E business-journey
 * finding N1): the requestor who creates an org-wide grant request may not
 * also sign either approval slot. Migration 000116 enforced only that the
 * two APPROVERS differ from each other; it never bound an approver to the
 * requestor. Over real HTTP a single session could request a grant and
 * self-approve the first signature (approver_one == requested_by),
 * violating the staged-chain rule every other workflow enforces in the
 * database (refunds 000110, admissions 000111, settlements 000112,
 * corrections 000113, bulk exports 000114, disposals 000115): the
 * requester/initiator and every signer must be distinct actors.
 *
 * The application command (GrantScopePermission::approve) enforces the same
 * rule; this trigger is the DB-level backstop so a bypass at the SQL layer
 * is rejected too. The function body below reproduces 000116's guard and
 * adds the requestor-independence checks.
 */
return new class extends Migration
{
    public function up(): void
    {
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

                -- Separation of duties: the requestor may never sign either
                -- approval slot (matches the application command rule).
                IF NEW.approver_one_id IS NOT NULL AND trim(NEW.approver_one_id) = trim(NEW.requested_by) THEN
                    RAISE EXCEPTION 'an organization-wide grant requestor may not also be the first approver'
                        USING ERRCODE = 'check_violation';
                END IF;
                IF NEW.approver_two_id IS NOT NULL AND trim(NEW.approver_two_id) = trim(NEW.requested_by) THEN
                    RAISE EXCEPTION 'an organization-wide grant requestor may not also be the second approver'
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

                RETURN NEW;
            END;
            $fn$ LANGUAGE plpgsql;
            SQL);
    }

    public function down(): void
    {
        // Restore the 000116 body (without the requestor-independence checks).
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

                IF OLD.lifecycle_state = 'granted' THEN
                    RAISE EXCEPTION 'an executed organization-wide grant request is closed'
                        USING ERRCODE = 'check_violation';
                END IF;

                IF OLD.lifecycle_state = 'requested' AND NEW.lifecycle_state = 'requested' THEN
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

                RETURN NEW;
            END;
            $fn$ LANGUAGE plpgsql;
            SQL);
    }
};
