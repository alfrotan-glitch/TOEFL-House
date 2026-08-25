<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Schema;

return new class extends Migration
{
    public function up(): void
    {
        Schema::create('guardian_relationships', function (Blueprint $table): void {
            $table->char('id', 36)->primary();
            $table->char('student_id', 36);
            $table->char('guardian_person_id', 36);
            $table->string('relationship');
            $table->json('permissions');
            $table->string('verification_state');
            $table->string('lifecycle_state');
            $table->date('effective_from');
            $table->date('effective_to')->nullable();
            $table->char('recorded_by', 36);
            $table->timestamps();
            $table->foreign('student_id')->references('id')->on('students');
            $table->foreign('guardian_person_id')->references('id')->on('people');
        });
        DB::statement("ALTER TABLE guardian_relationships ADD CONSTRAINT guardian_relationships_verification_state_check CHECK (verification_state IN ('unverified','verified'))");
        DB::statement("ALTER TABLE guardian_relationships ADD CONSTRAINT guardian_relationships_lifecycle_state_check CHECK (lifecycle_state IN ('active','revoked'))");
        DB::statement('ALTER TABLE guardian_relationships ADD CONSTRAINT guardian_relationships_period_check CHECK (effective_to IS NULL OR effective_to > effective_from)');
        DB::statement("CREATE UNIQUE INDEX guardian_relationships_one_open_per_pair ON guardian_relationships (student_id, guardian_person_id, relationship) WHERE lifecycle_state = 'active' AND effective_to IS NULL");
    }

    public function down(): void
    {
        Schema::dropIfExists('guardian_relationships');
    }
};
