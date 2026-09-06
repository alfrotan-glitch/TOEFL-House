<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Schema;

return new class extends Migration
{
    public function up(): void
    {
        Schema::create('graduation_decisions', function (Blueprint $table): void {
            $table->char('id', 36)->primary();
            $table->char('student_id', 36);
            $table->char('program_version_id', 36);
            $table->string('outcome');
            $table->string('basis');
            $table->string('lifecycle_state');
            $table->char('proposed_by', 36);
            $table->char('reviewed_by', 36)->nullable();
            $table->char('approved_by', 36)->nullable();
            $table->timestamps();
            $table->foreign('student_id')->references('id')->on('students');
            $table->foreign('program_version_id')->references('id')->on('program_versions');
        });
        DB::statement("ALTER TABLE graduation_decisions ADD CONSTRAINT graduation_decisions_outcome_check CHECK (outcome IN ('eligible','not_eligible'))");
        DB::statement("ALTER TABLE graduation_decisions ADD CONSTRAINT graduation_decisions_lifecycle_state_check CHECK (lifecycle_state IN ('proposed','reviewed','approved','rejected'))");
        DB::statement("CREATE UNIQUE INDEX graduation_decisions_one_open_per_student_version ON graduation_decisions (student_id, program_version_id) WHERE lifecycle_state IN ('proposed','reviewed','approved')");
    }

    public function down(): void
    {
        Schema::dropIfExists('graduation_decisions');
    }
};
