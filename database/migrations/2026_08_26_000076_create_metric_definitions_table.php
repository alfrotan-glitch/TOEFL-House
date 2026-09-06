<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Schema;

return new class extends Migration
{
    public function up(): void
    {
        Schema::create('metric_definitions', function (Blueprint $table): void {
            $table->char('id', 36)->primary();
            $table->string('key');
            $table->string('name');
            $table->string('source_owner');
            $table->string('period_authority');
            $table->integer('current_version');
            $table->char('defined_by', 36);
            $table->timestamps();
        });
        DB::statement("ALTER TABLE metric_definitions ADD CONSTRAINT metric_definitions_source_owner_check CHECK (source_owner IN ('finance','payroll','academic_delivery','academic','funding'))");
        DB::statement("ALTER TABLE metric_definitions ADD CONSTRAINT metric_definitions_period_authority_check CHECK (period_authority IN ('financial_period','payroll_period','academic_period'))");
        DB::statement('CREATE UNIQUE INDEX metric_definitions_key_unique ON metric_definitions (key)');
    }

    public function down(): void
    {
        Schema::dropIfExists('metric_definitions');
    }
};
