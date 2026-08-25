<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

return new class extends Migration
{
    public function up(): void
    {
        Schema::create('idempotency_keys', function (Blueprint $table): void {
            $table->char('id', 36)->primary();
            $table->string('operation');
            $table->string('idempotency_key');
            $table->string('payload_hash');
            $table->text('outcome');
            $table->timestamps();
            $table->unique(['operation', 'idempotency_key']);
        });
    }

    public function down(): void
    {
        Schema::dropIfExists('idempotency_keys');
    }
};
