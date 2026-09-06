<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Schema;

return new class extends Migration
{
    public function up(): void
    {
        Schema::create('academic_appeals', function (Blueprint $table): void {
            $table->char('id', 36)->primary();
            $table->char('student_id', 36);
            $table->string('subject_type');
            $table->char('subject_id', 36);
            $table->string('reason');
            $table->string('lifecycle_state');
            $table->char('assigned_reviewer_id', 36)->nullable();
            $table->string('outcome')->nullable();
            $table->string('outcome_evidence')->nullable();
            $table->char('decided_by', 36)->nullable();
            $table->timestamps();
            $table->foreign('student_id')->references('id')->on('students');
        });
        DB::statement("ALTER TABLE academic_appeals ADD CONSTRAINT academic_appeals_subject_type_check CHECK (subject_type IN ('assessment_result','progression_decision'))");
        DB::statement("ALTER TABLE academic_appeals ADD CONSTRAINT academic_appeals_lifecycle_state_check CHECK (lifecycle_state IN ('open','assigned','investigating','resolved','rejected','escalated','closed'))");
    }

    public function down(): void
    {
        Schema::dropIfExists('academic_appeals');
    }
};
