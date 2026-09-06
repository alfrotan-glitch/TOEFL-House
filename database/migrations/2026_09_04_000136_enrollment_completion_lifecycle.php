<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Schema;

/**
 * Enrollment completion lifecycle (AC5): reasoned freeze/withdraw, evidenced
 * completion.
 *
 * - state_reason: the human justification behind the current frozen /
 *   withdrawn / completed state (projection; history lives in audit_events).
 * - completion_basis: the mandatory human attestation recorded at completion.
 * - completion_evidence_kind/id: the verified assessed-delivery evidence
 *   pinned at completion (released assessment result or approved progression
 *   decision). Both NULL (legacy basis-only path) or both set.
 */
return new class extends Migration
{
    public function up(): void
    {
        Schema::table('enrollments', function (Blueprint $table): void {
            $table->text('state_reason')->nullable();
            $table->text('completion_basis')->nullable();
            $table->string('completion_evidence_kind', 32)->nullable();
            $table->char('completion_evidence_id', 36)->nullable();
        });

        DB::statement("ALTER TABLE enrollments ADD CONSTRAINT enrollments_completion_evidence_kind_check CHECK (completion_evidence_kind IS NULL OR completion_evidence_kind IN ('assessment_result','progression_decision'))");
        DB::statement('ALTER TABLE enrollments ADD CONSTRAINT enrollments_completion_evidence_pair_check CHECK ((completion_evidence_kind IS NULL) = (completion_evidence_id IS NULL))');
    }

    public function down(): void
    {
        DB::statement('ALTER TABLE enrollments DROP CONSTRAINT IF EXISTS enrollments_completion_evidence_pair_check');
        DB::statement('ALTER TABLE enrollments DROP CONSTRAINT IF EXISTS enrollments_completion_evidence_kind_check');

        Schema::table('enrollments', function (Blueprint $table): void {
            $table->dropColumn(['state_reason', 'completion_basis', 'completion_evidence_kind', 'completion_evidence_id']);
        });
    }
};
