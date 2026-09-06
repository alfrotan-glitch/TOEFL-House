<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

/**
 * Laravel's persistent cache store. Required so the login rate limiter (the
 * brute-force protection on the employee sign-in endpoint) survives across
 * PHP-FPM workers in a real deployment — an in-process (array) cache would
 * reset per worker and provide no protection. This is framework
 * infrastructure, not business data: it carries no domain invariants and is
 * pruned by expiration.
 */
return new class extends Migration
{
    public function up(): void
    {
        Schema::create('cache', function (Blueprint $table): void {
            $table->string('key')->primary();
            $table->mediumText('value');
            $table->integer('expiration');
        });

        Schema::create('cache_locks', function (Blueprint $table): void {
            $table->string('key')->primary();
            $table->string('owner');
            $table->integer('expiration');
        });
    }

    public function down(): void
    {
        Schema::dropIfExists('cache_locks');
        Schema::dropIfExists('cache');
    }
};
