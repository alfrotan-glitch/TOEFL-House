<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

return new class extends Migration
{
    public function up(): void
    {
        Schema::create('positions', function (Blueprint $table): void {
            $table->char('id', 36)->primary();
            $table->char('organization_id', 36);
            $table->string('name');
            $table->timestamps();
            $table->foreign('organization_id')->references('id')->on('organizations');
            $table->unique(['organization_id', 'name']);
        });
    }

    public function down(): void
    {
        Schema::dropIfExists('positions');
    }
};
