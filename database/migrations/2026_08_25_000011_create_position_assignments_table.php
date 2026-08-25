<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Schema;

return new class extends Migration
{
    public function up(): void
    {
        Schema::create('position_assignments', function (Blueprint $table): void {
            $table->char('id', 36)->primary();
            $table->char('person_id', 36);
            $table->char('position_id', 36);
            $table->string('lifecycle_state');
            $table->date('effective_from');
            $table->date('effective_to')->nullable();
            $table->char('assigned_by', 36);
            $table->timestamps();
            $table->foreign('person_id')->references('id')->on('people');
            $table->foreign('position_id')->references('id')->on('positions');
            $table->index(['person_id', 'lifecycle_state']);
        });
        DB::statement("ALTER TABLE position_assignments ADD CONSTRAINT position_assignments_lifecycle_state_check CHECK (lifecycle_state IN ('proposed','active','expired','revoked'))");
        DB::statement('CREATE UNIQUE INDEX position_assignments_one_open_per_person_position ON position_assignments (person_id, position_id) WHERE lifecycle_state = \'active\' AND effective_to IS NULL');
        DB::statement('ALTER TABLE position_assignments ADD CONSTRAINT position_assignments_period_check CHECK (effective_to IS NULL OR effective_to > effective_from)');
    }

    public function down(): void
    {
        Schema::dropIfExists('position_assignments');
    }
};
