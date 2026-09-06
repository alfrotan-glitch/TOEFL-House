<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Support\Facades\DB;

/**
 * Staged organization-wide data exports (PHASE_3 increment E) — the
 * bulk-export SoD becomes two-session, matching the staged pattern the
 * architecture already uses for refunds (000110), admissions (000111),
 * settlements (000112) and assessment corrections (000113):
 *
 *   - an EXPORTER session (holding privacy.export) requests an
 *     organization-wide export for a known subject with a stated
 *     purpose — the request is born 'requested';
 *   - two DISTINCT approver sessions (each holding
 *     privacy.approve_bulk_export, each in its own authenticated
 *     session) sign the request — the first fills approver_one, the
 *     second (a different person) fills approver_two and closes the
 *     request as 'approved';
 *   - the export is EXECUTED only from 'approved', by an exporter
 *     session; execution records the disclosure (the immutable
 *     evidence of the release) and closes the request as 'exported'.
 *
 * The command previously received both approvers' person ids in a
 * single request, which voided the SoD it enforced on the stored
 * identities. With staging, each signature is captured in its own
 * authenticated session and the boundary re-checks distinctness.
 *
 * Schema: privacy_export_requests with lifecycle_state ('requested' |
 * 'approved' | 'exported'). The privacy_export_requests_guard
 * consolidates the boundary rules:
 *
 *   - INSERT: a request is born 'requested', with no approver, exporter
 *     or disclosure recorded and a non-empty purpose;
 *   - UPDATE: requested -> approved (both approvers set and distinct)
 *     and approved -> exported (exporter + disclosure recorded);
 *     approver slots are written once, never rewritten; no other field
 *     changes;
 *   - DELETE: never (an export request is an auditable fact).
 */
return new class extends Migration
{
    public function up(): void
    {
        DB::statement(<<<'SQL'
            CREATE TABLE privacy_export_requests (
                id character(36) PRIMARY KEY,
                subject_person_id character(36) NOT NULL REFERENCES people (id),
                purpose character varying NOT NULL,
                organization_id character(36) NOT NULL,
                lifecycle_state character varying NOT NULL DEFAULT 'requested',
                requested_by character(36) NOT NULL,
                approver_one_id character(36),
                approver_two_id character(36),
                exported_by character(36),
                disclosure_id character(36),
                created_at timestamptz NOT NULL,
                updated_at timestamptz NOT NULL
            )
            SQL);
        DB::statement('ALTER TABLE privacy_export_requests ADD CONSTRAINT privacy_export_requests_purpose_check CHECK (char_length(purpose) > 0)');
        DB::statement("ALTER TABLE privacy_export_requests ADD CONSTRAINT privacy_export_requests_lifecycle_state_check CHECK (lifecycle_state IN ('requested', 'approved', 'exported'))");
        DB::statement('CREATE INDEX privacy_export_requests_subject_index ON privacy_export_requests (subject_person_id)');

        DB::statement(<<<'SQL'
            CREATE OR REPLACE FUNCTION privacy_export_requests_guard() RETURNS trigger AS $fn$
            BEGIN
                IF TG_OP = 'DELETE' THEN
                    RAISE EXCEPTION 'bulk export requests are auditable facts and cannot be deleted'
                        USING ERRCODE = 'check_violation';
                END IF;

                IF TG_OP = 'INSERT' THEN
                    IF NEW.lifecycle_state <> 'requested' THEN
                        RAISE EXCEPTION 'a bulk export request is born requested; only approval and execution change it (state: %)', NEW.lifecycle_state
                            USING ERRCODE = 'check_violation';
                    END IF;

                    IF NEW.approver_one_id IS NOT NULL OR NEW.approver_two_id IS NOT NULL
                        OR NEW.exported_by IS NOT NULL OR NEW.disclosure_id IS NOT NULL
                    THEN
                        RAISE EXCEPTION 'a bulk export request is born without approvers, exporter or disclosure'
                            USING ERRCODE = 'check_violation';
                    END IF;

                    RETURN NEW;
                END IF;

                -- UPDATE
                IF OLD.lifecycle_state = 'exported' THEN
                    RAISE EXCEPTION 'an executed bulk export request is closed'
                        USING ERRCODE = 'check_violation';
                END IF;

                IF OLD.lifecycle_state = 'requested' AND NEW.lifecycle_state = 'requested' THEN
                    -- The first signature: only the first approver slot may
                    -- be filled while the request stays requested.
                    IF OLD.approver_one_id IS NOT NULL OR NEW.approver_one_id IS NULL
                        OR NEW.approver_two_id IS NOT NULL
                    THEN
                        RAISE EXCEPTION 'a requested bulk export request accepts only its first approver signature'
                            USING ERRCODE = 'check_violation';
                    END IF;
                ELSIF OLD.lifecycle_state = 'requested' AND NEW.lifecycle_state = 'approved' THEN
                    IF NEW.approver_one_id IS NULL OR NEW.approver_two_id IS NULL THEN
                        RAISE EXCEPTION 'an approved bulk export request carries two distinct approvers'
                            USING ERRCODE = 'check_violation';
                    END IF;
                    IF trim(NEW.approver_one_id) = trim(NEW.approver_two_id) THEN
                        RAISE EXCEPTION 'a bulk export needs two distinct approvers'
                            USING ERRCODE = 'check_violation';
                    END IF;
                    IF NEW.exported_by IS NOT NULL OR NEW.disclosure_id IS NOT NULL THEN
                        RAISE EXCEPTION 'an approved bulk export request is not yet executed'
                            USING ERRCODE = 'check_violation';
                    END IF;
                ELSIF OLD.lifecycle_state = 'approved' AND NEW.lifecycle_state = 'exported' THEN
                    IF NEW.exported_by IS NULL OR NEW.disclosure_id IS NULL THEN
                        RAISE EXCEPTION 'executing a bulk export request records the exporter and the disclosure'
                            USING ERRCODE = 'check_violation';
                    END IF;
                ELSE
                    RAISE EXCEPTION 'a bulk export request moves only requested -> approved -> exported (state: % -> %)',
                        OLD.lifecycle_state, NEW.lifecycle_state
                        USING ERRCODE = 'check_violation';
                END IF;

                IF NEW.approver_one_id IS DISTINCT FROM OLD.approver_one_id
                    AND OLD.approver_one_id IS NOT NULL
                THEN
                    RAISE EXCEPTION 'an approver slot on a bulk export request is written once'
                        USING ERRCODE = 'check_violation';
                END IF;
                IF NEW.approver_two_id IS DISTINCT FROM OLD.approver_two_id
                    AND OLD.approver_two_id IS NOT NULL
                THEN
                    RAISE EXCEPTION 'an approver slot on a bulk export request is written once'
                        USING ERRCODE = 'check_violation';
                END IF;

                IF NEW.subject_person_id IS DISTINCT FROM OLD.subject_person_id
                    OR NEW.purpose IS DISTINCT FROM OLD.purpose
                    OR NEW.organization_id IS DISTINCT FROM OLD.organization_id
                    OR NEW.requested_by IS DISTINCT FROM OLD.requested_by
                    OR NEW.created_at IS DISTINCT FROM OLD.created_at
                THEN
                    RAISE EXCEPTION 'only the lifecycle state, approver slots, exporter and disclosure may change on a bulk export request'
                        USING ERRCODE = 'check_violation';
                END IF;

                RETURN NEW;
            END;
            $fn$ LANGUAGE plpgsql;
            SQL);
        DB::statement('CREATE TRIGGER privacy_export_requests_guard_trigger BEFORE INSERT OR UPDATE OR DELETE ON privacy_export_requests FOR EACH ROW EXECUTE FUNCTION privacy_export_requests_guard()');
    }

    public function down(): void
    {
        DB::statement('DROP TRIGGER IF EXISTS privacy_export_requests_guard_trigger ON privacy_export_requests');
        DB::statement('DROP FUNCTION IF EXISTS privacy_export_requests_guard()');
        DB::statement('DROP INDEX IF EXISTS privacy_export_requests_subject_index');
        DB::statement('DROP TABLE IF EXISTS privacy_export_requests');
    }
};
