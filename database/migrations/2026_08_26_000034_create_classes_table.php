<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Schema;

return new class extends Migration
{
    public function up(): void
    {
        Schema::create('classes', function (Blueprint $table): void {
            $table->char('id', 36)->primary();
            $table->char('program_version_id', 36);
            $table->char('period_id', 36);
            $table->integer('capacity');
            $table->string('lifecycle_state');
            $table->timestamps();
            $table->foreign('program_version_id')->references('id')->on('program_versions');
            $table->foreign('period_id')->references('id')->on('academic_periods');
        });
        DB::statement("ALTER TABLE classes ADD CONSTRAINT classes_lifecycle_state_check CHECK (lifecycle_state IN ('planned','published','active','cancelled','completed','archived'))");
        DB::statement('ALTER TABLE classes ADD CONSTRAINT classes_capacity_check CHECK (capacity > 0)');
    }

    public function down(): void
    {
        Schema::dropIfExists('classes');
    }
};
