<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Schema;

/**
 * AC3 enrollment financial gate (ADR-017).
 *
 * - `financial_credits`: Finance-approved student credit/advance.
 * - `enrollment_installment_plans`: Finance-approved alternative settlement.
 * - `financial_gate_exceptions`: Finance-approved scoped gate exception.
 * - Academic freezes the gate assessment evidence on `enrollments`.
 *
 * Approved rows are immutable (append-only correction history is a separate
 * controlled Finance action, never a silent rewrite).
 */
return new class extends Migration
{
    public function up(): void
    {
        Schema::create('financial_credits', function (Blueprint $table): void {
            $table->char('id', 36)->primary();
            $table->char('student_id', 36);
            $table->decimal('amount', 14, 2);
            $table->string('reason');
            $table->string('source_ref');
            $table->string('lifecycle_state');
            $table->char('requested_by', 36);
            $table->char('approved_by', 36)->nullable();
            $table->timestamp('approved_at')->nullable();
            $table->timestamps();
            $table->foreign('student_id')->references('id')->on('students');
        });
        DB::statement('ALTER TABLE financial_credits ADD CONSTRAINT financial_credits_amount_check CHECK (amount > 0)');
        DB::statement("ALTER TABLE financial_credits ADD CONSTRAINT financial_credits_lifecycle_check CHECK (lifecycle_state IN ('proposed','approved'))");
        DB::statement("ALTER TABLE financial_credits ADD CONSTRAINT financial_credits_source_ref_check CHECK (source_ref <> '')");
        DB::statement('CREATE UNIQUE INDEX financial_credits_source_ref_unique ON financial_credits (source_ref)');
        DB::statement(<<<'SQL'
            CREATE OR REPLACE FUNCTION financial_credits_approved_immutable() RETURNS trigger AS $fn$
            BEGIN
                IF OLD.lifecycle_state = 'approved' THEN
                    RAISE EXCEPTION 'approved financial credits are immutable; corrections are separate controlled Finance actions';
                END IF;
                RETURN NEW;
            END;
            $fn$ LANGUAGE plpgsql
            SQL);
        DB::statement('CREATE TRIGGER financial_credits_approved_immutable_trigger BEFORE UPDATE OR DELETE ON financial_credits FOR EACH ROW EXECUTE FUNCTION financial_credits_approved_immutable()');

        Schema::create('enrollment_installment_plans', function (Blueprint $table): void {
            $table->char('id', 36)->primary();
            $table->char('student_id', 36);
            $table->char('offering_id', 36)->nullable();
            $table->decimal('amount', 14, 2);
            $table->unsignedInteger('installments_count');
            $table->date('first_due_on');
            $table->string('schedule_ref');
            $table->string('lifecycle_state');
            $table->char('requested_by', 36);
            $table->char('approved_by', 36)->nullable();
            $table->timestamp('approved_at')->nullable();
            $table->timestamps();
            $table->foreign('student_id')->references('id')->on('students');
            $table->foreign('offering_id')->references('id')->on('offerings');
        });
        DB::statement('ALTER TABLE enrollment_installment_plans ADD CONSTRAINT enrollment_installment_plans_amount_check CHECK (amount > 0)');
        DB::statement('ALTER TABLE enrollment_installment_plans ADD CONSTRAINT enrollment_installment_plans_count_check CHECK (installments_count > 0)');
        DB::statement("ALTER TABLE enrollment_installment_plans ADD CONSTRAINT enrollment_installment_plans_lifecycle_check CHECK (lifecycle_state IN ('proposed','approved'))");
        DB::statement("ALTER TABLE enrollment_installment_plans ADD CONSTRAINT enrollment_installment_plans_schedule_ref_check CHECK (schedule_ref <> '')");
        DB::statement('CREATE UNIQUE INDEX enrollment_installment_plans_schedule_ref_unique ON enrollment_installment_plans (schedule_ref)');
        DB::statement(<<<'SQL'
            CREATE OR REPLACE FUNCTION enrollment_installment_plans_approved_immutable() RETURNS trigger AS $fn$
            BEGIN
                IF OLD.lifecycle_state = 'approved' THEN
                    RAISE EXCEPTION 'approved installment plans are immutable; corrections are separate controlled Finance actions';
                END IF;
                RETURN NEW;
            END;
            $fn$ LANGUAGE plpgsql
            SQL);
        DB::statement('CREATE TRIGGER enrollment_installment_plans_approved_immutable_trigger BEFORE UPDATE OR DELETE ON enrollment_installment_plans FOR EACH ROW EXECUTE FUNCTION enrollment_installment_plans_approved_immutable()');

        Schema::create('financial_gate_exceptions', function (Blueprint $table): void {
            $table->char('id', 36)->primary();
            $table->char('student_id', 36);
            $table->char('offering_id', 36)->nullable();
            $table->char('class_id', 36)->nullable();
            $table->decimal('amount', 14, 2);
            $table->string('reason');
            $table->date('effective_from');
            $table->date('effective_to')->nullable();
            $table->string('lifecycle_state');
            $table->char('requested_by', 36);
            $table->char('approved_by', 36)->nullable();
            $table->timestamp('approved_at')->nullable();
            $table->timestamps();
            $table->foreign('student_id')->references('id')->on('students');
            $table->foreign('offering_id')->references('id')->on('offerings');
            $table->foreign('class_id')->references('id')->on('classes');
        });
        DB::statement('ALTER TABLE financial_gate_exceptions ADD CONSTRAINT financial_gate_exceptions_amount_check CHECK (amount > 0)');
        DB::statement("ALTER TABLE financial_gate_exceptions ADD CONSTRAINT financial_gate_exceptions_lifecycle_check CHECK (lifecycle_state IN ('proposed','approved'))");
        DB::statement("ALTER TABLE financial_gate_exceptions ADD CONSTRAINT financial_gate_exceptions_reason_check CHECK (reason <> '')");
        DB::statement('ALTER TABLE financial_gate_exceptions ADD CONSTRAINT financial_gate_exceptions_window_check CHECK (effective_to IS NULL OR effective_to >= effective_from)');
        DB::statement(<<<'SQL'
            CREATE OR REPLACE FUNCTION financial_gate_exceptions_approved_immutable() RETURNS trigger AS $fn$
            BEGIN
                IF OLD.lifecycle_state = 'approved' THEN
                    RAISE EXCEPTION 'approved financial gate exceptions are immutable; corrections are separate controlled Finance actions';
                END IF;
                RETURN NEW;
            END;
            $fn$ LANGUAGE plpgsql
            SQL);
        DB::statement('CREATE TRIGGER financial_gate_exceptions_approved_immutable_trigger BEFORE UPDATE OR DELETE ON financial_gate_exceptions FOR EACH ROW EXECUTE FUNCTION financial_gate_exceptions_approved_immutable()');

        Schema::table('enrollments', function (Blueprint $table): void {
            $table->jsonb('financial_gate_evidence')->nullable();
            $table->char('financial_gate_evidence_sha256', 64)->nullable();
            $table->char('financial_gate_signature', 64)->nullable();
            $table->timestamp('financial_gate_assessed_at')->nullable();
            $table->boolean('financial_gate_satisfied')->nullable();
        });
    }

    public function down(): void
    {
        Schema::table('enrollments', function (Blueprint $table): void {
            $table->dropColumn([
                'financial_gate_satisfied', 'financial_gate_assessed_at',
                'financial_gate_signature', 'financial_gate_evidence_sha256',
                'financial_gate_evidence',
            ]);
        });

        DB::statement('DROP TRIGGER IF EXISTS financial_gate_exceptions_approved_immutable_trigger ON financial_gate_exceptions');
        DB::statement('DROP FUNCTION IF EXISTS financial_gate_exceptions_approved_immutable()');
        Schema::dropIfExists('financial_gate_exceptions');

        DB::statement('DROP TRIGGER IF EXISTS enrollment_installment_plans_approved_immutable_trigger ON enrollment_installment_plans');
        DB::statement('DROP FUNCTION IF EXISTS enrollment_installment_plans_approved_immutable()');
        Schema::dropIfExists('enrollment_installment_plans');

        DB::statement('DROP TRIGGER IF EXISTS financial_credits_approved_immutable_trigger ON financial_credits');
        DB::statement('DROP FUNCTION IF EXISTS financial_credits_approved_immutable()');
        Schema::dropIfExists('financial_credits');
    }
};
