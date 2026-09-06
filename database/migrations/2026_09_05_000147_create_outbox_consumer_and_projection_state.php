<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Schema;

/**
 * Durable relay/consumer state. Domain events remain immutable source facts;
 * these rows only record at-least-once processing and rebuild requests.
 */
return new class extends Migration
{
    public function up(): void
    {
        Schema::create('event_consumer_receipts', function (Blueprint $table): void {
            $table->char('id', 36)->primary();
            $table->char('event_id', 36);
            $table->string('consumer_key');
            $table->string('status');
            $table->integer('attempts')->default(0);
            $table->integer('max_attempts')->default(5);
            $table->timestampTz('next_attempt_at')->nullable();
            $table->timestampTz('claimed_at')->nullable();
            $table->timestampTz('lease_until')->nullable();
            $table->text('last_error')->nullable();
            $table->timestampTz('processed_at')->nullable();
            $table->timestamps();
            $table->foreign('event_id')->references('id')->on('domain_events');
            $table->unique(['event_id', 'consumer_key']);
            $table->index(['status', 'next_attempt_at']);
        });
        DB::statement("ALTER TABLE event_consumer_receipts ADD CONSTRAINT event_consumer_receipts_status_check CHECK (status IN ('pending','processing','succeeded','failed','dead_letter'))");
        DB::statement("ALTER TABLE event_consumer_receipts ADD CONSTRAINT event_consumer_receipts_attempts_check CHECK (attempts >= 0 AND max_attempts BETWEEN 1 AND 20)");
        DB::statement("ALTER TABLE event_consumer_receipts ADD CONSTRAINT event_consumer_receipts_state_check CHECK ((status = 'processing' AND lease_until IS NOT NULL AND next_attempt_at IS NULL AND processed_at IS NULL) OR (status = 'succeeded' AND lease_until IS NULL AND next_attempt_at IS NULL AND processed_at IS NOT NULL) OR (status IN ('pending','failed','dead_letter') AND lease_until IS NULL AND processed_at IS NULL))");

        Schema::create('projection_invalidations', function (Blueprint $table): void {
            $table->char('id', 36)->primary();
            $table->string('projection_key');
            $table->char('event_id', 36);
            $table->string('aggregate_type');
            // Projection targets follow the event aggregate contract: an
            // aggregate identity may be a UUID or a governed natural key.
            $table->string('aggregate_id');
            $table->string('status');
            $table->string('reason');
            $table->timestampTz('requested_at');
            $table->timestampTz('rebuilt_at')->nullable();
            $table->text('last_error')->nullable();
            $table->timestamps();
            $table->foreign('event_id')->references('id')->on('domain_events');
            $table->unique(['projection_key', 'event_id']);
            $table->index(['projection_key', 'status', 'requested_at']);
        });
        DB::statement("ALTER TABLE projection_invalidations ADD CONSTRAINT projection_invalidations_status_check CHECK (status IN ('pending','processing','rebuilt','failed'))");
    }

    public function down(): void
    {
        DB::statement('ALTER TABLE projection_invalidations DROP CONSTRAINT IF EXISTS projection_invalidations_status_check');
        DB::statement('ALTER TABLE event_consumer_receipts DROP CONSTRAINT IF EXISTS event_consumer_receipts_state_check');
        DB::statement('ALTER TABLE event_consumer_receipts DROP CONSTRAINT IF EXISTS event_consumer_receipts_attempts_check');
        DB::statement('ALTER TABLE event_consumer_receipts DROP CONSTRAINT IF EXISTS event_consumer_receipts_status_check');
        Schema::dropIfExists('projection_invalidations');
        Schema::dropIfExists('event_consumer_receipts');
    }
};
