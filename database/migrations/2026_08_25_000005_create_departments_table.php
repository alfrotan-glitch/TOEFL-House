<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Schema;

return new class extends Migration
{
    public function up(): void
    {
        Schema::create('departments', function (Blueprint $table): void {
            $table->char('id', 36)->primary();
            $table->string('name');
            $table->string('lifecycle_state');
            $table->string('scope_type');
            $table->char('scope_id', 36);
            $table->timestamps();
            $table->unique(['scope_type', 'scope_id', 'name']);
        });
        DB::statement("ALTER TABLE departments ADD CONSTRAINT departments_lifecycle_state_check CHECK (lifecycle_state IN ('draft','active','suspended','closed','reopened'))");
        DB::statement("ALTER TABLE departments ADD CONSTRAINT departments_scope_type_check CHECK (scope_type IN ('organization','campus','branch'))");
    }

    public function down(): void
    {
        Schema::dropIfExists('departments');
    }
};
