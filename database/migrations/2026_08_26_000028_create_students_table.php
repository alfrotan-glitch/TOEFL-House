<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Schema;

return new class extends Migration
{
    public function up(): void
    {
        Schema::create('students', function (Blueprint $table): void {
            $table->char('id', 36)->primary();
            $table->char('person_id', 36);
            $table->char('admission_decision_id', 36);
            $table->string('student_code');
            $table->timestamps();
            $table->foreign('person_id')->references('id')->on('people');
            $table->foreign('admission_decision_id')->references('id')->on('admission_decisions');
            $table->unique('student_code');
        });
        DB::statement('CREATE UNIQUE INDEX students_one_per_person ON students (person_id)');
    }

    public function down(): void
    {
        Schema::dropIfExists('students');
    }
};
