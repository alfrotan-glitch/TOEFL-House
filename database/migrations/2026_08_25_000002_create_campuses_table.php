<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Schema;

return new class extends Migration
{
    public function up(): void
    {
        Schema::create('campuses', function (Blueprint $table): void {
            $table->char('id', 36)->primary();
            $table->char('organization_id', 36);
            $table->string('name');
            $table->string('lifecycle_state');
            $table->timestamps();
            $table->foreign('organization_id')->references('id')->on('organizations');
            $table->unique(['organization_id', 'name']);
        });
        DB::statement("ALTER TABLE campuses ADD CONSTRAINT campuses_lifecycle_state_check CHECK (lifecycle_state IN ('draft','active','suspended','closed','reopened'))");
    }

    public function down(): void
    {
        Schema::dropIfExists('campuses');
    }
};
