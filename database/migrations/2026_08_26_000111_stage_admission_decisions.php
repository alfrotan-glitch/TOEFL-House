<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Support\Facades\DB;

/**
 * Staged admission decisions (PHASE_3) — the decision workflow becomes
 * three-session, matching the staged SoD pattern the architecture already
 * uses for refunds, discounts, and contract versions:
 *
 *   - an INITIATOR (admissions.initiate) opens the decision: outcome,
 *     reason, and evidence are fixed at initiation; the decision is born
 *     'proposed';
 *   - a REVIEWER (admissions.review, a different person) reviews it in
 *     their own session — the decision becomes 'reviewed';
 *   - an APPROVER (admissions.approve, a third person) finalizes it — the
 *     decision becomes 'final' and, in the same database statement path,
 *     the applicant transitions to admitted/rejected.
 *
 * The transport previously fabricated the reviewer and approver from
 * request input (a single session typed any person ids), which voided the
 * SoD the command and schema enforce on the stored identities. With
 * staging, each signature is captured in its own authenticated session.
 *
 * Schema: admission_decisions gains lifecycle_state
 * ('proposed' | 'reviewed' | 'final'); reviewer_id and approver_id become
 * nullable until their stage passes. The base append-only trigger (000027,
 * no UPDATE/DELETE at all) and the 000106 decision guard (three-party SoD
 * on INSERT) are consolidated into one admission_decisions_lifecycle_guard:
 *
 *   - INSERT: a decision is born proposed with only its initiator; reason
 *     and evidence are mandatory; only an applicant in the decidable state
 *     (row-locked) may be decided;
 *   - UPDATE: only the lifecycle may advance, one stage at a time, and
 *     only the stage's signature column may be set; progressive SoD —
 *     reviewer differs from initiator, approver differs from both;
 *     outcome/reason/evidence/applicant/initiator are frozen from the
 *     moment of initiation;
 *   - finalization is what transitions the applicant: the guard performs
 *     the applicants update itself, so a direct SQL statement can never
 *     declare a decision final while the applicant stays put;
 *   - DELETE: never (decisions are append-only history).
 *
 * Final decisions remain exactly as immutable as before.
 */
return new class extends Migration
{
    public function up(): void
    {
        DB::statement("ALTER TABLE admission_decisions ADD COLUMN IF NOT EXISTS lifecycle_state character varying NOT NULL DEFAULT 'final'");
        DB::statement('ALTER TABLE admission_decisions DROP CONSTRAINT IF EXISTS admission_decisions_lifecycle_state_check');
        DB::statement("ALTER TABLE admission_decisions ADD CONSTRAINT admission_decisions_lifecycle_state_check CHECK (lifecycle_state IN ('proposed', 'reviewed', 'final'))");
        DB::statement('ALTER TABLE admission_decisions ALTER COLUMN reviewer_id DROP NOT NULL');
        DB::statement('ALTER TABLE admission_decisions ALTER COLUMN approver_id DROP NOT NULL');

        DB::statement('DROP TRIGGER IF EXISTS admission_decisions_append_only_trigger ON admission_decisions');
        DB::statement('DROP FUNCTION IF EXISTS admission_decisions_append_only()');
        DB::statement('DROP TRIGGER IF EXISTS admission_decisions_guard_trigger ON admission_decisions');
        DB::statement('DROP FUNCTION IF EXISTS admission_decisions_guard()');

        DB::statement(<<<'SQL'
            CREATE OR REPLACE FUNCTION admission_decisions_lifecycle_guard() RETURNS trigger AS $fn$
            DECLARE
                applicant_state text;
            BEGIN
                SELECT a.lifecycle_state INTO applicant_state
                  FROM applicants a WHERE a.id = NEW.applicant_id FOR UPDATE;
                IF applicant_state IS NULL THEN
                    RAISE EXCEPTION 'admission decision references missing applicant %', NEW.applicant_id
                        USING ERRCODE = 'foreign_key_violation';
                END IF;

                IF TG_OP = 'INSERT' THEN
                    IF NEW.lifecycle_state IS DISTINCT FROM 'proposed' THEN
                        RAISE EXCEPTION 'an admission decision is born proposed (state: %)', NEW.lifecycle_state
                            USING ERRCODE = 'check_violation';
                    END IF;

                    IF NEW.initiator_id IS NULL OR trim(NEW.initiator_id) = '' THEN
                        RAISE EXCEPTION 'an admission decision requires its initiator'
                            USING ERRCODE = 'check_violation';
                    END IF;

                    IF NEW.reviewer_id IS NOT NULL OR NEW.approver_id IS NOT NULL THEN
                        RAISE EXCEPTION 'a proposed admission decision carries only its initiator'
                            USING ERRCODE = 'check_violation';
                    END IF;

                    IF NEW.reason IS NULL OR trim(NEW.reason) = ''
                        OR NEW.evidence_ref IS NULL OR trim(NEW.evidence_ref) = '' THEN
                        RAISE EXCEPTION 'an admission decision requires its reason and evidence reference'
                            USING ERRCODE = 'check_violation';
                    END IF;

                    IF applicant_state <> 'applicant' THEN
                        RAISE EXCEPTION 'only an applicant in the decidable state may be decided (currently %)',
                            applicant_state
                            USING ERRCODE = 'check_violation';
                    END IF;

                    RETURN NEW;
                END IF;

                -- UPDATE
                IF OLD.applicant_id IS DISTINCT FROM NEW.applicant_id
                   OR OLD.outcome IS DISTINCT FROM NEW.outcome
                   OR OLD.reason IS DISTINCT FROM NEW.reason
                   OR OLD.evidence_ref IS DISTINCT FROM NEW.evidence_ref
                   OR OLD.initiator_id IS DISTINCT FROM NEW.initiator_id THEN
                    RAISE EXCEPTION 'an admission decision may only advance its lifecycle (state, reviewer, approver); its substance is frozen at initiation'
                        USING ERRCODE = 'check_violation';
                END IF;

                IF applicant_state <> 'applicant' THEN
                    RAISE EXCEPTION 'the applicant of this decision is no longer in the decidable state (currently %)',
                        applicant_state
                        USING ERRCODE = 'check_violation';
                END IF;

                IF OLD.lifecycle_state = 'proposed' THEN
                    IF NEW.lifecycle_state IS DISTINCT FROM 'reviewed' THEN
                        RAISE EXCEPTION 'a proposed decision may only become reviewed (state: %)', NEW.lifecycle_state
                            USING ERRCODE = 'check_violation';
                    END IF;

                    IF NEW.reviewer_id IS NULL OR trim(NEW.reviewer_id) = '' THEN
                        RAISE EXCEPTION 'reviewing a decision requires its reviewer'
                            USING ERRCODE = 'check_violation';
                    END IF;

                    IF NEW.approver_id IS NOT NULL THEN
                        RAISE EXCEPTION 'a reviewed decision has no approver yet'
                            USING ERRCODE = 'check_violation';
                    END IF;

                    IF trim(NEW.reviewer_id) = trim(OLD.initiator_id) THEN
                        RAISE EXCEPTION 'the admission reviewer must differ from the initiator'
                            USING ERRCODE = 'check_violation';
                    END IF;

                    RETURN NEW;
                END IF;

                IF OLD.lifecycle_state = 'reviewed' THEN
                    IF NEW.lifecycle_state IS DISTINCT FROM 'final' THEN
                        RAISE EXCEPTION 'a reviewed decision may only become final (state: %)', NEW.lifecycle_state
                            USING ERRCODE = 'check_violation';
                    END IF;

                    IF NEW.approver_id IS NULL OR trim(NEW.approver_id) = '' THEN
                        RAISE EXCEPTION 'approving a decision requires its approver'
                            USING ERRCODE = 'check_violation';
                    END IF;

                    IF trim(NEW.approver_id) = trim(OLD.initiator_id)
                        OR trim(NEW.approver_id) = trim(OLD.reviewer_id) THEN
                        RAISE EXCEPTION 'the admission approver must differ from the initiator and the reviewer'
                            USING ERRCODE = 'check_violation';
                    END IF;

                    -- Finalizing a decision IS what transitions the
                    -- applicant; no statement can declare a decision final
                    -- while the applicant stays in the decidable state.
                    UPDATE applicants
                       SET lifecycle_state = CASE WHEN NEW.outcome = 'admit' THEN 'admitted' ELSE 'rejected' END,
                           updated_at = now()
                     WHERE id = NEW.applicant_id;

                    RETURN NEW;
                END IF;

                RAISE EXCEPTION 'a final admission decision is immutable (state: %)', OLD.lifecycle_state
                    USING ERRCODE = 'check_violation';
            END;
            $fn$ LANGUAGE plpgsql;
            SQL);
        DB::statement('DROP TRIGGER IF EXISTS admission_decisions_lifecycle_guard_trigger ON admission_decisions');
        DB::statement('CREATE TRIGGER admission_decisions_lifecycle_guard_trigger BEFORE INSERT OR UPDATE ON admission_decisions FOR EACH ROW EXECUTE FUNCTION admission_decisions_lifecycle_guard()');
    }

    public function down(): void
    {
        DB::statement('DROP TRIGGER IF EXISTS admission_decisions_lifecycle_guard_trigger ON admission_decisions');
        DB::statement('DROP FUNCTION IF EXISTS admission_decisions_lifecycle_guard()');

        // Un-staged rollback: restore the 000106 guard and the base
        // append-only trigger. Rollback-only backfill for any unstaged rows
        // (dev databases); the applicant states are NOT reverted.
        DB::statement('UPDATE admission_decisions SET reviewer_id = initiator_id WHERE lifecycle_state = \'proposed\' AND reviewer_id IS NULL');
        DB::statement('UPDATE admission_decisions SET approver_id = reviewer_id WHERE reviewer_id IS NOT NULL AND approver_id IS NULL');

        DB::statement(<<<'SQL'
            CREATE OR REPLACE FUNCTION admission_decisions_guard() RETURNS trigger AS $fn$
            DECLARE
                applicant_state text;
            BEGIN
                IF trim(NEW.initiator_id) = trim(NEW.reviewer_id)
                    OR trim(NEW.initiator_id) = trim(NEW.approver_id)
                    OR trim(NEW.reviewer_id) = trim(NEW.approver_id) THEN
                    RAISE EXCEPTION 'the admission initiator, reviewer, and approver must be distinct actors'
                        USING ERRCODE = 'check_violation';
                END IF;

                IF NEW.reason IS NULL OR trim(NEW.reason) = ''
                    OR NEW.evidence_ref IS NULL OR trim(NEW.evidence_ref) = '' THEN
                    RAISE EXCEPTION 'an admission decision requires its reason and evidence reference'
                        USING ERRCODE = 'check_violation';
                END IF;

                SELECT a.lifecycle_state INTO applicant_state
                  FROM applicants a WHERE a.id = NEW.applicant_id FOR UPDATE;
                IF applicant_state IS NULL THEN
                    RAISE EXCEPTION 'admission decision references missing applicant %', NEW.applicant_id
                        USING ERRCODE = 'foreign_key_violation';
                END IF;
                IF applicant_state <> 'applicant' THEN
                    RAISE EXCEPTION 'only an applicant in the decidable state may be decided (currently %)',
                        applicant_state
                        USING ERRCODE = 'check_violation';
                END IF;

                RETURN NEW;
            END;
            $fn$ LANGUAGE plpgsql;
            SQL);
        DB::statement('CREATE TRIGGER admission_decisions_guard_trigger BEFORE INSERT ON admission_decisions FOR EACH ROW EXECUTE FUNCTION admission_decisions_guard()');

        DB::statement(<<<'SQL'
            CREATE OR REPLACE FUNCTION admission_decisions_append_only() RETURNS trigger AS $fn$
            BEGIN
                RAISE EXCEPTION 'admission_decisions is append-only';
            END;
            $fn$ LANGUAGE plpgsql;
            SQL);
        DB::statement('CREATE TRIGGER admission_decisions_append_only_trigger BEFORE UPDATE OR DELETE ON admission_decisions FOR EACH ROW EXECUTE FUNCTION admission_decisions_append_only()');

        DB::statement('ALTER TABLE admission_decisions ALTER COLUMN approver_id SET NOT NULL');
        DB::statement('ALTER TABLE admission_decisions ALTER COLUMN reviewer_id SET NOT NULL');
        DB::statement('ALTER TABLE admission_decisions DROP CONSTRAINT IF EXISTS admission_decisions_lifecycle_state_check');
        DB::statement('ALTER TABLE admission_decisions DROP COLUMN IF EXISTS lifecycle_state');
    }
};
