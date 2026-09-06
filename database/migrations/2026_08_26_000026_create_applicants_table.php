<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Schema;

return new class extends Migration
{
    public function up(): void
    {
        Schema::create('applicants', function (Blueprint $table): void {
            $table->char('id', 36)->primary();
            $table->char('person_id', 36);
            $table->string('program_interest');
            $table->string('lifecycle_state');
            $table->char('recorded_by', 36);
            $table->timestamps();
            $table->foreign('person_id')->references('id')->on('people');
        });
        DB::statement("ALTER TABLE applicants ADD CONSTRAINT applicants_lifecycle_state_check CHECK (lifecycle_state IN ('prospect','applicant','admitted','rejected'))");
    }

    public function down(): void
    {
        Schema::dropIfExists('applicants');
    }
};
