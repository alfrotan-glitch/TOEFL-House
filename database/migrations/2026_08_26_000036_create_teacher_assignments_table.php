<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Schema;

return new class extends Migration
{
    public function up(): void
    {
        Schema::create('teacher_assignments', function (Blueprint $table): void {
            $table->char('id', 36)->primary();
            $table->char('class_id', 36);
            $table->char('teacher_person_id', 36);
            $table->date('effective_from');
            $table->date('effective_to')->nullable();
            $table->timestamps();
            $table->foreign('class_id')->references('id')->on('classes');
            $table->foreign('teacher_person_id')->references('id')->on('people');
        });
        DB::statement('ALTER TABLE teacher_assignments ADD CONSTRAINT teacher_assignments_period_check CHECK (effective_to IS NULL OR effective_to > effective_from)');
        DB::statement('CREATE UNIQUE INDEX teacher_assignments_one_open_per_class_teacher ON teacher_assignments (class_id, teacher_person_id) WHERE effective_to IS NULL');
    }

    public function down(): void
    {
        Schema::dropIfExists('teacher_assignments');
    }
};
