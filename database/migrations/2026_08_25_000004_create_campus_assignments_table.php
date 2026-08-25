<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Schema;

return new class extends Migration
{
    public function up(): void
    {
        Schema::create('campus_assignments', function (Blueprint $table): void {
            $table->char('id', 36)->primary();
            $table->char('branch_id', 36);
            $table->char('campus_id', 36);
            $table->date('effective_from');
            $table->date('effective_to')->nullable();
            $table->string('transfer_correlation_id');
            $table->foreign('branch_id')->references('id')->on('branches');
            $table->foreign('campus_id')->references('id')->on('campuses');
            $table->index(['campus_id', 'effective_from']);
        });
        DB::statement('CREATE UNIQUE INDEX campus_assignments_one_open_per_branch ON campus_assignments (branch_id) WHERE effective_to IS NULL');
        DB::statement('ALTER TABLE campus_assignments ADD CONSTRAINT campus_assignments_period_check CHECK (effective_to IS NULL OR effective_to > effective_from)');
    }

    public function down(): void
    {
        Schema::dropIfExists('campus_assignments');
    }
};
