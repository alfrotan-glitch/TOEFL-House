<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Support\Facades\DB;

/**
 * Schema-level payroll-evidence guard for teaching delivery facts.
 *
 * A teaching delivery fact is the raw evidence CalculatePayroll pays skill
 * rules against. The claim trigger already makes facts immutable after
 * creation and forbids deletion, but a direct SQL INSERT could still forge a
 * fact (inflated hours, a skill the teacher never delivered, a session
 * outside the claiming period, or a session that was never attended). This
 * trigger makes a fact admissible only if it exactly matches the evidence:
 *
 *   - the fact's skill and date equal its session's skill and date;
 *   - the session falls inside the claiming calculation's payroll period;
 *   - the claiming teacher is actually assigned to the session's class on
 *     that date AND that skill is attributed to the assignment;
 *   - the session has qualifying attendance (present/late, uncorrected);
 *   - the fact's hours equal the session's duration (minute precision,
 *     scale-2 truncation, exactly as CalculatePayroll derives them).
 *
 * This mirrors — not replaces — CalculatePayroll::claimDelivery, which stays
 * the single authoritative implementation.
 */
return new class extends Migration
{
    public function up(): void
    {
        DB::statement(<<<'SQL'
            CREATE OR REPLACE FUNCTION teaching_delivery_facts_evidence() RETURNS trigger AS $fn$
            DECLARE
                session_skill char(36);
                session_date date;
                session_class char(36);
                session_start time;
                session_end time;
                calc_period char(36);
                calc_employment char(36);
                employment_person char(36);
                period_from date;
                period_to date;
                teacher_assigned boolean;
                attendance_ok boolean;
                minutes bigint;
                derived_hours numeric;
            BEGIN
                SELECT cs.skill_id, cs.scheduled_on, cs.class_id, cs.starts_at, cs.ends_at
                  INTO session_skill, session_date, session_class, session_start, session_end
                  FROM class_sessions cs WHERE cs.id = NEW.session_id;
                IF session_skill IS NULL THEN
                    RAISE EXCEPTION 'delivery fact references missing session %', NEW.session_id
                        USING ERRCODE = 'foreign_key_violation';
                END IF;

                SELECT pc.period_id, pc.employment_id INTO calc_period, calc_employment
                  FROM payroll_calculations pc WHERE pc.id = NEW.payroll_calculation_id;
                IF calc_period IS NULL THEN
                    RAISE EXCEPTION 'delivery fact references missing calculation %', NEW.payroll_calculation_id
                        USING ERRCODE = 'foreign_key_violation';
                END IF;

                SELECT pp.date_from, pp.date_to INTO period_from, period_to
                  FROM payroll_periods pp WHERE pp.id = calc_period;
                SELECT e.person_id INTO employment_person
                  FROM employments e WHERE e.id = calc_employment;

                IF NEW.skill_id <> session_skill OR NEW.scheduled_on <> session_date THEN
                    RAISE EXCEPTION 'delivery fact skill or date does not match its session'
                        USING ERRCODE = 'check_violation';
                END IF;
                IF session_date < period_from OR session_date > period_to THEN
                    RAISE EXCEPTION 'delivery fact session falls outside the claiming calculation period'
                        USING ERRCODE = 'check_violation';
                END IF;

                SELECT EXISTS(
                    SELECT 1
                      FROM teacher_assignments ta
                      JOIN teacher_assignment_skills tas ON tas.teacher_assignment_id = ta.id
                     WHERE ta.class_id = session_class
                       AND ta.teacher_person_id = employment_person
                       AND tas.skill_id = session_skill
                       AND ta.effective_from <= session_date
                       AND (ta.effective_to IS NULL OR ta.effective_to >= session_date)
                ) INTO teacher_assigned;
                IF NOT teacher_assigned THEN
                    RAISE EXCEPTION 'delivery fact skill is not attributed to the claiming teacher for that session'
                        USING ERRCODE = 'check_violation';
                END IF;

                SELECT EXISTS(
                    SELECT 1 FROM attendance_facts af
                     WHERE af.session_id = NEW.session_id
                       AND af.status IN ('present', 'late')
                       AND NOT EXISTS (SELECT 1 FROM attendance_facts af2 WHERE af2.corrects_id = af.id)
                ) INTO attendance_ok;
                IF NOT attendance_ok THEN
                    RAISE EXCEPTION 'delivery fact requires qualifying attendance on its session'
                        USING ERRCODE = 'check_violation';
                END IF;

                minutes := floor(extract(epoch from (session_end - session_start)) / 60);
                derived_hours := floor(minutes * 100.0 / 60.0) / 100.0;
                IF NEW.hours <> derived_hours THEN
                    RAISE EXCEPTION 'delivery fact hours (%) do not match the session duration (%)',
                        NEW.hours, derived_hours
                        USING ERRCODE = 'check_violation';
                END IF;

                RETURN NEW;
            END;
            $fn$ LANGUAGE plpgsql;
            SQL);
        DB::statement('DROP TRIGGER IF EXISTS teaching_delivery_facts_evidence_trigger ON teaching_delivery_facts');
        DB::statement('CREATE TRIGGER teaching_delivery_facts_evidence_trigger BEFORE INSERT ON teaching_delivery_facts FOR EACH ROW EXECUTE FUNCTION teaching_delivery_facts_evidence()');
    }

    public function down(): void
    {
        DB::statement('DROP TRIGGER IF EXISTS teaching_delivery_facts_evidence_trigger ON teaching_delivery_facts');
        DB::statement('DROP FUNCTION IF EXISTS teaching_delivery_facts_evidence()');
    }
};
