<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Schema;

return new class extends Migration
{
    public function up(): void
    {
        Schema::create('branches', function (Blueprint $table): void {
            $table->char('id', 36)->primary();
            $table->string('name');
            $table->string('lifecycle_state');
            $table->timestamps();
            $table->unique('name');
        });
        DB::statement("ALTER TABLE branches ADD CONSTRAINT branches_lifecycle_state_check CHECK (lifecycle_state IN ('draft','active','suspended','closed','reopened'))");
    }

    public function down(): void
    {
        Schema::dropIfExists('branches');
    }
};
