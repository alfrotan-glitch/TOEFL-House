<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Schema;

/**
 * Finance-owned per-case scholarship award.
 *
 * The canonical financial domain model (foundation 34) names Scholarship
 * Award/Allocation as an "approved student benefit and funding application
 * (award rule, student, fund, period)". The generic restricted-fund engine
 * (FundingSource + FundAllocation) is the monetary application; this record is
 * the per-case, per-donor attribution decision that ties a specific student to
 * a specific funding source and period under a concrete award rule. It does
 * not itself alter any balance (FundAllocation remains the only monetary
 * application); it provides the auditable, attributable aid-package decision.
 */
return new class extends Migration
{
    public function up(): void
    {
        Schema::create('scholarship_awards', function (Blueprint $table): void {
            $table->char('id', 36)->primary();
            $table->char('student_id', 36);
            $table->char('funding_source_id', 36);
            $table->char('period_id', 36);
            $table->decimal('amount', 14, 2);
            $table->string('award_rule_ref');
            $table->string('reason');
            $table->string('lifecycle_state');
            $table->char('requested_by', 36);
            $table->char('approved_by', 36)->nullable();
            $table->timestamp('approved_at')->nullable();
            $table->timestamps();
            $table->foreign('student_id')->references('id')->on('students');
            $table->foreign('funding_source_id')->references('id')->on('funding_sources');
            $table->foreign('period_id')->references('id')->on('financial_periods');
            $table->foreign('requested_by')->references('id')->on('people');
            $table->foreign('approved_by')->references('id')->on('people');
        });
        DB::statement('ALTER TABLE scholarship_awards ADD CONSTRAINT scholarship_awards_amount_check CHECK (amount > 0)');
        DB::statement('ALTER TABLE scholarship_awards ADD CONSTRAINT scholarship_awards_rule_ref_check CHECK (award_rule_ref <> \'\')');
        DB::statement('ALTER TABLE scholarship_awards ADD CONSTRAINT scholarship_awards_reason_check CHECK (reason <> \'\')');
        DB::statement("ALTER TABLE scholarship_awards ADD CONSTRAINT scholarship_awards_state_check CHECK (lifecycle_state IN ('proposed', 'approved'))");

        DB::statement(<<<'SQL'
            CREATE OR REPLACE FUNCTION scholarship_awards_guard() RETURNS trigger AS $fn$
            DECLARE
                student_branch char(36);
                fund_organization char(36);
                student_organization char(36);
            BEGIN
                IF TG_OP = 'DELETE' THEN
                    RAISE EXCEPTION 'scholarship awards are immutable financial facts; corrections append compensating facts'
                        USING ERRCODE = 'check_violation';
                END IF;

                IF NOT EXISTS (
                    SELECT 1 FROM financial_periods fp
                     WHERE fp.id = NEW.period_id
                       AND fp.lifecycle_state = 'open'
                     FOR UPDATE
                ) THEN
                    RAISE EXCEPTION 'a scholarship award requires an open financial period'
                        USING ERRCODE = 'check_violation';
                END IF;

                SELECT organization_id INTO fund_organization
                  FROM funding_sources WHERE id = NEW.funding_source_id;
                IF fund_organization IS NULL OR NOT EXISTS (
                    SELECT 1 FROM organizations o
                     WHERE o.id = fund_organization AND o.lifecycle_state = 'active'
                ) THEN
                    RAISE EXCEPTION 'a scholarship award requires a funding source with active organization provenance'
                        USING ERRCODE = 'check_violation';
                END IF;

                SELECT COALESCE(s.current_home_branch_id, s.originating_branch_id)
                  INTO student_branch
                  FROM students s WHERE s.id = NEW.student_id;
                IF student_branch IS NULL THEN
                    RAISE EXCEPTION 'a scholarship award requires known student branch provenance'
                        USING ERRCODE = 'check_violation';
                END IF;
                SELECT o.organization_id INTO student_organization
                  FROM branches b
                  JOIN campus_assignments ca ON ca.branch_id = b.id AND ca.effective_from <= CURRENT_DATE AND (ca.effective_to IS NULL OR ca.effective_to > CURRENT_DATE)
                  JOIN campuses c ON c.id = ca.campus_id
                  JOIN organizations o ON o.id = c.organization_id
                 WHERE b.id = student_branch
                 LIMIT 1;
                IF student_organization IS NULL OR student_organization <> fund_organization THEN
                    RAISE EXCEPTION 'a scholarship award cannot cross funding-source and student organizations'
                        USING ERRCODE = 'check_violation';
                END IF;

                IF TG_OP = 'INSERT' THEN
                    IF NEW.lifecycle_state <> 'proposed' THEN
                        RAISE EXCEPTION 'a scholarship award is born proposed and requires an independent approval'
                            USING ERRCODE = 'check_violation';
                    END IF;
                    RETURN NEW;
                END IF;

                IF OLD.lifecycle_state = 'approved' THEN
                    RAISE EXCEPTION 'approved scholarship awards are immutable'
                        USING ERRCODE = 'check_violation';
                END IF;
                IF NEW.lifecycle_state <> 'approved' THEN
                    RAISE EXCEPTION 'a scholarship award may transition only proposed -> approved'
                        USING ERRCODE = 'check_violation';
                END IF;
                IF OLD.student_id IS DISTINCT FROM NEW.student_id
                   OR OLD.funding_source_id IS DISTINCT FROM NEW.funding_source_id
                   OR OLD.period_id IS DISTINCT FROM NEW.period_id
                   OR OLD.amount IS DISTINCT FROM NEW.amount
                   OR OLD.award_rule_ref IS DISTINCT FROM NEW.award_rule_ref
                   OR OLD.reason IS DISTINCT FROM NEW.reason
                   OR OLD.requested_by IS DISTINCT FROM NEW.requested_by THEN
                    RAISE EXCEPTION 'a scholarship award source and terms are immutable'
                        USING ERRCODE = 'check_violation';
                END IF;
                IF NEW.approved_by IS NULL OR trim(NEW.approved_by) = trim(NEW.requested_by) THEN
                    RAISE EXCEPTION 'a scholarship award requires an independent approver distinct from the requester'
                        USING ERRCODE = 'check_violation';
                END IF;

                RETURN NEW;
            END;
            $fn$ LANGUAGE plpgsql;
            SQL);
        DB::statement('CREATE TRIGGER scholarship_awards_guard_trigger BEFORE INSERT OR UPDATE OR DELETE ON scholarship_awards FOR EACH ROW EXECUTE FUNCTION scholarship_awards_guard()');
        // One attributed award per student, donor, and period — a per-case aid
        // decision cannot be granted twice for the same benefit window.
        DB::statement('CREATE UNIQUE INDEX scholarship_awards_one_per_student_fund_period ON scholarship_awards (student_id, funding_source_id, period_id)');
    }

    public function down(): void
    {
        DB::statement('DROP TRIGGER IF EXISTS scholarship_awards_guard_trigger ON scholarship_awards');
        DB::statement('DROP FUNCTION IF EXISTS scholarship_awards_guard()');
        Schema::dropIfExists('scholarship_awards');
    }
};
