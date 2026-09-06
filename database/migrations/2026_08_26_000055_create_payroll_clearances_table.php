<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Schema;

return new class extends Migration
{
    public function up(): void
    {
        Schema::create('payroll_clearances', function (Blueprint $table): void {
            $table->char('id', 36)->primary();
            $table->char('employment_id', 36);
            $table->string('domain');
            $table->char('cleared_by', 36);
            $table->string('note');
            $table->timestamps();
            $table->foreign('employment_id')->references('id')->on('employments');
        });
        DB::statement("ALTER TABLE payroll_clearances ADD CONSTRAINT payroll_clearances_domain_check CHECK (domain IN ('hr','finance'))");
        DB::statement('CREATE UNIQUE INDEX payroll_clearances_one_per_domain ON payroll_clearances (employment_id, domain)');
    }

    public function down(): void
    {
        DB::statement('DROP INDEX IF EXISTS payroll_clearances_one_per_domain');
        Schema::dropIfExists('payroll_clearances');
    }
};
