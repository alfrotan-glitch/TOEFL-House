<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Schema;

return new class extends Migration
{
    public function up(): void
    {
        Schema::create('academic_periods', function (Blueprint $table): void {
            $table->char('id', 36)->primary();
            $table->string('name');
            $table->date('starts_on');
            $table->date('ends_on');
            $table->string('lifecycle_state');
            $table->timestamps();
        });
        DB::statement("ALTER TABLE academic_periods ADD CONSTRAINT academic_periods_lifecycle_state_check CHECK (lifecycle_state IN ('draft','published','closed'))");
        DB::statement('ALTER TABLE academic_periods ADD CONSTRAINT academic_periods_period_check CHECK (ends_on > starts_on)');
    }

    public function down(): void
    {
        Schema::dropIfExists('academic_periods');
    }
};
