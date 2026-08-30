<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Support\Facades\DB;

/**
 * Staged assessment-result corrections (PHASE_3) — the score-correction
 * workflow becomes two-session, matching the staged SoD pattern the
 * architecture already uses for refunds (000110), admissions (000111)
 * and settlements (000112):
 *
 *   - a correction is BORN as a PROPOSAL: a MODERATOR session (holding
 *     academic.moderate) proposes a new score with a mandatory reason
 *     against a released (or appealed) result;
 *   - an APPROVER session (a different person, holding
 *     academic.approve_result) approves the proposal — the only path by
 *     which the original result is closed as 'corrected' and the new
 *     released result (with the corrects_id link and correction reason)
 *     is recorded.
 *
 * The transport previously received both signatures from a single request
 * (the caller typed the colleague's person id), which voided the SoD the
 * command enforces on the stored identities. With staging, each signature
 * is captured in its own authenticated session.
 *
 * Schema: result_corrections with lifecycle_state ('proposed' |
 * 'approved'); approved_by nullable until approval; one open correction
 * per result (partial unique index). The result_corrections_guard
 * consolidates the boundary rules:
 *
 *   - INSERT: a correction is born proposed, only against a result in a
 *     correctable state (released | appealed), row-locked on the result;
 *   - UPDATE: only proposed -> approved, and only the lifecycle state
 *     and approved_by may change; the approver must differ from the
 *     proposer (SoD mirrored at the boundary);
 *   - DELETE: never (a correction is an auditable fact).
 *
 * assessment_results stays exactly as guarded before (immutable attempts,
 * lifecycle CHECK, one live result per attempt).
 */
return new class extends Migration
{
    public function up(): void
    {
        DB::statement(<<<'SQL'
            CREATE TABLE result_corrections (
                id character(36) PRIMARY KEY,
                result_id character(36) NOT NULL REFERENCES assessment_results (id),
                score numeric(6, 2) NOT NULL,
                reason text NOT NULL,
                lifecycle_state character varying NOT NULL DEFAULT 'proposed',
                proposed_by character(36) NOT NULL,
                approved_by character(36),
                created_at timestamptz NOT NULL,
                updated_at timestamptz NOT NULL
            )
            SQL);
        DB::statement('ALTER TABLE result_corrections ADD CONSTRAINT result_corrections_score_check CHECK (score >= 0)');
        DB::statement('ALTER TABLE result_corrections ADD CONSTRAINT result_corrections_reason_check CHECK (char_length(reason) > 0)');
        DB::statement("ALTER TABLE result_corrections ADD CONSTRAINT result_corrections_lifecycle_state_check CHECK (lifecycle_state IN ('proposed', 'approved'))");
        DB::statement('CREATE UNIQUE INDEX result_corrections_one_open_per_result ON result_corrections (result_id) WHERE lifecycle_state = \'proposed\'');

        DB::statement(<<<'SQL'
            CREATE OR REPLACE FUNCTION result_corrections_guard() RETURNS trigger AS $fn$
            DECLARE
                result_state text;
            BEGIN
                IF TG_OP = 'DELETE' THEN
                    RAISE EXCEPTION 'result corrections are auditable facts and cannot be deleted'
                        USING ERRCODE = 'check_violation';
                END IF;

                IF TG_OP = 'INSERT' THEN
                    IF NEW.lifecycle_state <> 'proposed' THEN
                        RAISE EXCEPTION 'a result correction is born proposed; only approval records it (state: %)', NEW.lifecycle_state
                            USING ERRCODE = 'check_violation';
                    END IF;

                    SELECT r.lifecycle_state INTO result_state
                      FROM assessment_results r WHERE r.id = NEW.result_id FOR UPDATE;
                    IF result_state IS NULL THEN
                        RAISE EXCEPTION 'result correction references missing result %', NEW.result_id
                            USING ERRCODE = 'foreign_key_violation';
                    END IF;

                    IF result_state NOT IN ('released', 'appealed') THEN
                        RAISE EXCEPTION 'a result correction targets a released or appealed result (currently %)', result_state
                            USING ERRCODE = 'check_violation';
                    END IF;

                    RETURN NEW;
                END IF;

                -- UPDATE
                IF OLD.lifecycle_state = 'approved' THEN
                    RAISE EXCEPTION 'an approved result correction is closed'
                        USING ERRCODE = 'check_violation';
                END IF;

                IF NEW.lifecycle_state IS DISTINCT FROM 'approved' THEN
                    RAISE EXCEPTION 'a proposed correction may only become approved (state: %)', NEW.lifecycle_state
                        USING ERRCODE = 'check_violation';
                END IF;

                IF NEW.score IS DISTINCT FROM OLD.score
                    OR NEW.reason IS DISTINCT FROM OLD.reason
                    OR NEW.result_id IS DISTINCT FROM OLD.result_id
                    OR NEW.proposed_by IS DISTINCT FROM OLD.proposed_by
                    OR NEW.created_at IS DISTINCT FROM OLD.created_at
                THEN
                    RAISE EXCEPTION 'only the lifecycle state and approved_by may change on a result correction'
                        USING ERRCODE = 'check_violation';
                END IF;

                IF NEW.approved_by IS NULL THEN
                    RAISE EXCEPTION 'approving a result correction requires the approver'
                        USING ERRCODE = 'check_violation';
                END IF;

                IF trim(NEW.approved_by) = trim(OLD.proposed_by) THEN
                    RAISE EXCEPTION 'a correction needs a moderator and an approver as distinct actors'
                        USING ERRCODE = 'check_violation';
                END IF;

                RETURN NEW;
            END;
            $fn$ LANGUAGE plpgsql;
            SQL);
        DB::statement('CREATE TRIGGER result_corrections_guard_trigger BEFORE INSERT OR UPDATE OR DELETE ON result_corrections FOR EACH ROW EXECUTE FUNCTION result_corrections_guard()');
    }

    public function down(): void
    {
        DB::statement('DROP TRIGGER IF EXISTS result_corrections_guard_trigger ON result_corrections');
        DB::statement('DROP FUNCTION IF EXISTS result_corrections_guard()');
        DB::statement('DROP INDEX IF EXISTS result_corrections_one_open_per_result');
        DB::statement('DROP TABLE IF EXISTS result_corrections');
    }
};
