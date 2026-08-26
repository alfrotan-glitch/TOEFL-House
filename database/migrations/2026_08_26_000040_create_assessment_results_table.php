<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Schema;

return new class extends Migration
{
    public function up(): void
    {
        Schema::create('assessment_results', function (Blueprint $table): void {
            $table->char('id', 36)->primary();
            $table->char('attempt_id', 36);
            $table->decimal('score', 6, 2);
            $table->string('lifecycle_state');
            $table->char('corrects_id', 36)->nullable();
            $table->string('correction_reason')->nullable();
            $table->char('scored_by', 36);
            $table->char('moderated_by', 36)->nullable();
            $table->char('approved_by', 36)->nullable();
            $table->char('released_by', 36)->nullable();
            $table->timestamps();
            $table->foreign('attempt_id')->references('id')->on('assessment_attempts');
        });
        DB::statement("ALTER TABLE assessment_results ADD CONSTRAINT assessment_results_lifecycle_state_check CHECK (lifecycle_state IN ('scored','moderated','approved','released','appealed','corrected'))");
        DB::statement('ALTER TABLE assessment_results ADD CONSTRAINT assessment_results_score_check CHECK (score >= 0)');
        DB::statement("CREATE UNIQUE INDEX assessment_results_one_live_per_attempt ON assessment_results (attempt_id) WHERE lifecycle_state NOT IN ('corrected')");
    }

    public function down(): void
    {
        Schema::dropIfExists('assessment_results');
    }
};
