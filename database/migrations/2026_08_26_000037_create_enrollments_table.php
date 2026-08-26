<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Schema;

return new class extends Migration
{
    public function up(): void
    {
        Schema::create('enrollments', function (Blueprint $table): void {
            $table->char('id', 36)->primary();
            $table->char('student_id', 36);
            $table->char('class_id', 36);
            $table->string('lifecycle_state');
            $table->timestamps();
            $table->foreign('student_id')->references('id')->on('students');
            $table->foreign('class_id')->references('id')->on('classes');
        });
        DB::statement("ALTER TABLE enrollments ADD CONSTRAINT enrollments_lifecycle_state_check CHECK (lifecycle_state IN ('requested','active','frozen','transferred','withdrawn','completed'))");
        DB::statement("CREATE UNIQUE INDEX enrollments_one_active_seat ON enrollments (student_id, class_id) WHERE lifecycle_state = 'active'");
    }

    public function down(): void
    {
        Schema::dropIfExists('enrollments');
    }
};
