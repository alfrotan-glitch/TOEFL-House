<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

return new class extends Migration
{
    public function up(): void
    {
        Schema::create('consent_purposes', function (Blueprint $table): void {
            $table->char('id', 36)->primary();
            $table->string('name');
            $table->string('channel');
            $table->string('category');
            $table->timestamps();
            $table->unique(['name', 'channel']);
        });
    }

    public function down(): void
    {
        Schema::dropIfExists('consent_purposes');
    }
};
