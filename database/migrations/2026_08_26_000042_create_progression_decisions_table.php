<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Schema;

return new class extends Migration
{
    public function up(): void
    {
        Schema::create('progression_decisions', function (Blueprint $table): void {
            $table->char('id', 36)->primary();
            $table->char('student_id', 36);
            $table->char('class_id', 36);
            $table->string('outcome');
            $table->string('reason');
            $table->string('lifecycle_state');
            $table->char('superseded_by_id', 36)->nullable();
            $table->char('proposed_by', 36);
            $table->char('reviewed_by', 36)->nullable();
            $table->char('approved_by', 36)->nullable();
            $table->timestamps();
            $table->foreign('student_id')->references('id')->on('students');
            $table->foreign('class_id')->references('id')->on('classes');
        });
        DB::statement("ALTER TABLE progression_decisions ADD CONSTRAINT progression_decisions_outcome_check CHECK (outcome IN ('advance','repeat'))");
        DB::statement("ALTER TABLE progression_decisions ADD CONSTRAINT progression_decisions_lifecycle_state_check CHECK (lifecycle_state IN ('proposed','reviewed','approved','rejected','appealed','superseded'))");
        DB::statement("CREATE UNIQUE INDEX progression_decisions_one_open_per_student_class ON progression_decisions (student_id, class_id) WHERE lifecycle_state IN ('proposed','reviewed','approved','appealed')");
    }

    public function down(): void
    {
        Schema::dropIfExists('progression_decisions');
    }
};
