<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Schema;

return new class extends Migration
{
    public function up(): void
    {
        Schema::create('retention_rules', function (Blueprint $table): void {
            $table->char('id', 36)->primary();
            $table->string('category');
            $table->integer('retention_days');
            $table->string('legal_basis');
            $table->string('operational_basis')->nullable();
            $table->timestamps();
            $table->unique('category');
        });
        DB::statement('ALTER TABLE retention_rules ADD CONSTRAINT retention_rules_positive_period_check CHECK (retention_days > 0)');
    }

    public function down(): void
    {
        Schema::dropIfExists('retention_rules');
    }
};
