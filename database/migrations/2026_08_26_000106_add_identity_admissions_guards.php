<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Support\Facades\DB;

/**
 * Schema-level identity and admissions guards — the remaining decision
 * invariants enforced at the authoritative database boundary so a direct
 * SQL statement (bypassing the application) can never:
 *
 *   (1) forge a verified identity without its decision evidence
 *       (identity key, evidence reference, verifier, timestamp), or
 *       rewrite/retroactively un-verify a verified person — verified
 *       persons are the foundation of every employment, payroll, and
 *       settlement in the system;
 *   (2) forge an admission decision: the three decision actors must be
 *       distinct (SoD), the decision must carry reason and evidence, and
 *       only an applicant in the decidable state may be decided.
 *
 * These triggers mirror — not replace — the domain commands
 * (VerifyPerson, DecideAdmission), which remain the single authoritative
 * implementation of each rule.
 */
return new class extends Migration
{
    public function up(): void
    {
        DB::statement(<<<'SQL'
            CREATE OR REPLACE FUNCTION people_identity_guard() RETURNS trigger AS $fn$
            BEGIN
                IF TG_OP = 'UPDATE' THEN
                    IF OLD.verification_state = 'verified' THEN
                        RAISE EXCEPTION 'a verified person is final; identity evidence cannot be rewritten or revoked'
                            USING ERRCODE = 'check_violation';
                    END IF;

                    IF NEW.verification_state = 'verified' THEN
                        IF NEW.identity_key IS NULL OR trim(NEW.identity_key) = ''
                            OR NEW.identity_evidence_ref IS NULL OR trim(NEW.identity_evidence_ref) = ''
                            OR NEW.verified_by IS NULL OR trim(NEW.verified_by) = ''
                            OR NEW.verified_at IS NULL THEN
                            RAISE EXCEPTION 'verifying a person requires its identity key, evidence reference, verifier, and timestamp'
                                USING ERRCODE = 'check_violation';
                        END IF;
                    END IF;

                    RETURN NEW;
                END IF;

                IF NEW.verification_state = 'verified' THEN
                    IF NEW.identity_key IS NULL OR trim(NEW.identity_key) = ''
                        OR NEW.identity_evidence_ref IS NULL OR trim(NEW.identity_evidence_ref) = ''
                        OR NEW.verified_by IS NULL OR trim(NEW.verified_by) = ''
                        OR NEW.verified_at IS NULL THEN
                        RAISE EXCEPTION 'a verified person requires its identity key, evidence reference, verifier, and timestamp'
                            USING ERRCODE = 'check_violation';
                    END IF;
                END IF;

                RETURN NEW;
            END;
            $fn$ LANGUAGE plpgsql;
            SQL);
        DB::statement('DROP TRIGGER IF EXISTS people_identity_guard_trigger ON people');
        DB::statement('CREATE TRIGGER people_identity_guard_trigger BEFORE INSERT OR UPDATE ON people FOR EACH ROW EXECUTE FUNCTION people_identity_guard()');

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
        DB::statement('DROP TRIGGER IF EXISTS admission_decisions_guard_trigger ON admission_decisions');
        DB::statement('CREATE TRIGGER admission_decisions_guard_trigger BEFORE INSERT ON admission_decisions FOR EACH ROW EXECUTE FUNCTION admission_decisions_guard()');
    }

    public function down(): void
    {
        DB::statement('DROP TRIGGER IF EXISTS admission_decisions_guard_trigger ON admission_decisions');
        DB::statement('DROP FUNCTION IF EXISTS admission_decisions_guard()');
        DB::statement('DROP TRIGGER IF EXISTS people_identity_guard_trigger ON people');
        DB::statement('DROP FUNCTION IF EXISTS people_identity_guard()');
    }
};
