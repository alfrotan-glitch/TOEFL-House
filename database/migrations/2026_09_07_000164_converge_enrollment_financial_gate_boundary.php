<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Support\Facades\DB;

/**
 * Complete the enrollment/Finance boundary for direct database writes.
 *
 * Academic owns whether a seat becomes active, but it may do so only after it
 * has frozen a complete, satisfied Finance assessment. The application also
 * verifies Finance's HMAC before it reaches this point. PostgreSQL cannot
 * safely hold the application HMAC key, so this trigger enforces the full
 * structural/contextual contract and protects the frozen snapshot from later
 * rewrites; deployment roles must still deny arbitrary table DML to preserve
 * the cryptographic boundary.
 */
return new class extends Migration
{
    public function up(): void
    {
        DB::statement(<<<'SQL'
            CREATE OR REPLACE FUNCTION enrollments_financial_gate_activation_guard() RETURNS trigger AS $fn$
            BEGIN
                -- An activation (or any later active-row write) must carry a
                -- complete, satisfied evidence envelope bound to this exact
                -- membership. HMAC verification remains in the Finance-to-
                -- Academic application boundary because its key is not DB data.
                IF NEW.lifecycle_state = 'active' THEN
                    IF NEW.financial_gate_evidence IS NULL
                       OR jsonb_typeof(NEW.financial_gate_evidence) <> 'object'
                       OR NEW.financial_gate_evidence_sha256 IS NULL
                       OR NEW.financial_gate_signature IS NULL
                       OR NEW.financial_gate_assessed_at IS NULL
                       OR NEW.financial_gate_satisfied IS DISTINCT FROM TRUE
                       OR NEW.financial_gate_evidence_sha256 !~ '^[0-9a-f]{64}$'
                       OR NEW.financial_gate_signature !~ '^[0-9a-f]{64}$'
                       OR NEW.financial_gate_evidence->>'schema_version' IS DISTINCT FROM 'enrollment-financial-gate-v1'
                       OR NEW.financial_gate_evidence->'satisfied' IS DISTINCT FROM 'true'::jsonb
                       OR COALESCE(NEW.financial_gate_evidence->>'student_id', '') <> trim(NEW.student_id)
                       OR COALESCE(NEW.financial_gate_evidence->>'class_id', '') <> trim(NEW.class_id)
                       OR NULLIF(NEW.financial_gate_evidence->>'offering_id', '') IS DISTINCT FROM NULLIF(trim(NEW.offering_id), '')
                       OR COALESCE(NEW.financial_gate_evidence->>'assessed_at', '') = ''
                       OR COALESCE(NEW.financial_gate_evidence->>'uncovered', '') !~ '^[0-9]{1,12}(\.[0-9]{1,2})?$'
                       OR COALESCE(NEW.financial_gate_evidence->>'remaining', '') !~ '^[0-9]{1,12}(\.[0-9]{1,2})?$' THEN
                        RAISE EXCEPTION 'activating an enrollment requires complete, satisfied Finance gate evidence bound to the enrollment'
                            USING ERRCODE = 'check_violation';
                    END IF;
                END IF;

                -- Once a seat has been active, the activation assessment is a
                -- historical snapshot. Freeze/withdraw/complete operations may
                -- add their own audit snapshots but cannot rewrite these facts.
                IF OLD.lifecycle_state = 'active'
                   AND (NEW.financial_gate_evidence IS DISTINCT FROM OLD.financial_gate_evidence
                        OR NEW.financial_gate_evidence_sha256 IS DISTINCT FROM OLD.financial_gate_evidence_sha256
                        OR NEW.financial_gate_signature IS DISTINCT FROM OLD.financial_gate_signature
                        OR NEW.financial_gate_assessed_at IS DISTINCT FROM OLD.financial_gate_assessed_at
                        OR NEW.financial_gate_satisfied IS DISTINCT FROM OLD.financial_gate_satisfied) THEN
                    RAISE EXCEPTION 'the Finance gate assessment frozen at enrollment activation is immutable history'
                        USING ERRCODE = 'check_violation';
                END IF;

                RETURN NEW;
            END;
            $fn$ LANGUAGE plpgsql;
            SQL);
        DB::statement('DROP TRIGGER IF EXISTS enrollments_financial_gate_activation_guard_trigger ON enrollments');
        DB::statement('CREATE TRIGGER enrollments_financial_gate_activation_guard_trigger BEFORE UPDATE ON enrollments FOR EACH ROW EXECUTE FUNCTION enrollments_financial_gate_activation_guard()');
    }

    public function down(): void
    {
        DB::statement('DROP TRIGGER IF EXISTS enrollments_financial_gate_activation_guard_trigger ON enrollments');
        DB::statement('DROP FUNCTION IF EXISTS enrollments_financial_gate_activation_guard()');
    }
};
