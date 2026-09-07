<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Schema;

/**
 * Finance-owned operating expense.
 *
 * The canonical financial domain model (foundation 34) names Expense as an
 * "approved business cost request and financial source (supplier, purpose,
 * amount, approval)". Until now expenses could only be entered as generic
 * obligations or ad-hoc journals, which is not an authoritative operating-cost
 * fact. This table is the Finance source fact: an expense record is born
 * proposed, is approved by a distinct actor in an open financial period, is
 * branch-provenanced and immutable once approved, and is journalized exactly
 * once through PostJournal (source_type 'expense').
 */
return new class extends Migration
{
    public function up(): void
    {
        Schema::create('expenses', function (Blueprint $table): void {
            $table->char('id', 36)->primary();
            $table->char('period_id', 36);
            $table->string('supplier');
            $table->string('purpose');
            $table->string('category');
            $table->decimal('amount', 14, 2);
            $table->string('source_ref');
            $table->char('expense_account_id', 36);
            $table->string('lifecycle_state');
            $table->char('requested_by', 36);
            $table->char('approved_by', 36)->nullable();
            $table->timestamp('approved_at')->nullable();
            $table->char('originating_branch_id', 36)->nullable();
            $table->char('current_home_branch_id', 36)->nullable();
            $table->timestamps();
            $table->foreign('period_id')->references('id')->on('financial_periods');
            $table->foreign('expense_account_id')->references('id')->on('accounts');
            $table->foreign('requested_by')->references('id')->on('people');
            $table->foreign('approved_by')->references('id')->on('people');
            $table->foreign('originating_branch_id')->references('id')->on('branches');
            $table->foreign('current_home_branch_id')->references('id')->on('branches');
        });
        DB::statement('ALTER TABLE expenses ADD CONSTRAINT expenses_amount_check CHECK (amount > 0)');
        DB::statement('CREATE UNIQUE INDEX expenses_source_ref_per_branch_unique ON expenses (originating_branch_id, source_ref)');
        DB::statement('ALTER TABLE expenses ADD CONSTRAINT expenses_supplier_check CHECK (supplier <> \'\')');
        DB::statement('ALTER TABLE expenses ADD CONSTRAINT expenses_purpose_check CHECK (purpose <> \'\')');
        DB::statement('ALTER TABLE expenses ADD CONSTRAINT expenses_category_check CHECK (category <> \'\')');
        DB::statement('ALTER TABLE expenses ADD CONSTRAINT expenses_source_ref_check CHECK (source_ref <> \'\')');
        DB::statement("ALTER TABLE expenses ADD CONSTRAINT expenses_state_check CHECK (lifecycle_state IN ('proposed', 'approved'))");
        // An approved expense is an authorized operating cost. Its branch
        // provenance records where the cost was incurred, never re-derived.
        DB::statement(<<<'SQL'
            CREATE OR REPLACE FUNCTION expenses_guard() RETURNS trigger AS $fn$
            DECLARE
                expense_branch char(36);
                expense_organization char(36);
            BEGIN
                IF TG_OP = 'DELETE' THEN
                    RAISE EXCEPTION 'expenses are immutable financial facts; corrections append compensating facts'
                        USING ERRCODE = 'check_violation';
                END IF;

                SELECT COALESCE(NEW.current_home_branch_id, NEW.originating_branch_id)
                  INTO expense_branch;
                IF expense_branch IS NULL OR NOT EXISTS (
                    SELECT 1 FROM branches b
                     WHERE b.id = expense_branch
                       AND b.lifecycle_state = 'active'
                ) THEN
                    RAISE EXCEPTION 'expenses require known active branch provenance'
                        USING ERRCODE = 'check_violation';
                END IF;

                SELECT o.organization_id INTO expense_organization
                  FROM branches b
                  JOIN campus_assignments ca ON ca.branch_id = b.id AND ca.effective_from <= CURRENT_DATE AND (ca.effective_to IS NULL OR ca.effective_to > CURRENT_DATE)
                  JOIN campuses c ON c.id = ca.campus_id
                  JOIN organizations o ON o.id = c.organization_id
                 WHERE b.id = expense_branch
                 LIMIT 1;
                IF expense_organization IS NULL OR NOT EXISTS (
                    SELECT 1 FROM organizations o
                     WHERE o.id = expense_organization AND o.lifecycle_state = 'active'
                ) THEN
                    RAISE EXCEPTION 'expenses require active organization provenance'
                        USING ERRCODE = 'check_violation';
                END IF;

                IF NOT EXISTS (
                    SELECT 1 FROM financial_periods fp
                     WHERE fp.id = NEW.period_id
                       AND fp.lifecycle_state = 'open'
                     FOR UPDATE
                ) THEN
                    RAISE EXCEPTION 'expenses require an open financial period'
                        USING ERRCODE = 'check_violation';
                END IF;

                IF TG_OP = 'INSERT' THEN
                    IF NEW.lifecycle_state <> 'proposed' THEN
                        RAISE EXCEPTION 'an expense is born proposed and requires an independent approval'
                            USING ERRCODE = 'check_violation';
                    END IF;
                    IF NEW.approved_by IS NOT NULL OR NEW.approved_at IS NOT NULL THEN
                        RAISE EXCEPTION 'a proposed expense cannot carry approval evidence'
                            USING ERRCODE = 'check_violation';
                    END IF;
                    RETURN NEW;
                END IF;

                -- UPDATE
                IF OLD.lifecycle_state = 'approved' THEN
                    RAISE EXCEPTION 'approved expenses are immutable financial facts'
                        USING ERRCODE = 'check_violation';
                END IF;
                IF NEW.lifecycle_state <> 'approved' THEN
                    RAISE EXCEPTION 'an expense may transition only proposed -> approved'
                        USING ERRCODE = 'check_violation';
                END IF;
                IF OLD.period_id IS DISTINCT FROM NEW.period_id
                   OR OLD.supplier IS DISTINCT FROM NEW.supplier
                   OR OLD.purpose IS DISTINCT FROM NEW.purpose
                   OR OLD.category IS DISTINCT FROM NEW.category
                   OR OLD.amount IS DISTINCT FROM NEW.amount
                   OR OLD.source_ref IS DISTINCT FROM NEW.source_ref
                   OR OLD.expense_account_id IS DISTINCT FROM NEW.expense_account_id
                   OR OLD.requested_by IS DISTINCT FROM NEW.requested_by
                   OR OLD.originating_branch_id IS DISTINCT FROM NEW.originating_branch_id
                   OR OLD.current_home_branch_id IS DISTINCT FROM NEW.current_home_branch_id THEN
                    RAISE EXCEPTION 'an expense source and terms are immutable; approve the proposal or create a new fact'
                        USING ERRCODE = 'check_violation';
                END IF;
                IF NEW.approved_by IS NULL OR trim(NEW.approved_by) = trim(NEW.requested_by) THEN
                    RAISE EXCEPTION 'an expense requires an independent approver distinct from the requester'
                        USING ERRCODE = 'check_violation';
                END IF;

                RETURN NEW;
            END;
            $fn$ LANGUAGE plpgsql;
            SQL);
        DB::statement('CREATE TRIGGER expenses_guard_trigger BEFORE INSERT OR UPDATE OR DELETE ON expenses FOR EACH ROW EXECUTE FUNCTION expenses_guard()');
    }

    public function down(): void
    {
        DB::statement('DROP TRIGGER IF EXISTS expenses_guard_trigger ON expenses');
        DB::statement('DROP FUNCTION IF EXISTS expenses_guard()');
        Schema::dropIfExists('expenses');
    }
};
