<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

return new class extends Migration
{
    public function up(): void
    {
        Schema::table('audit_events', function (Blueprint $table): void {
            // PHASE_4 performance: the audit trail is the one unbounded,
            // append-only table, and the audit console lists it newest-first
            // (ORDER BY occurred_at DESC). Without this index that listing
            // is a sequential scan + top-N sort that degrades linearly with
            // history. Measured on a 20k-row audit trail: 4.3ms -> 0.09ms
            // (backward index scan), and the index keeps the listing flat as
            // history grows.
            $table->index('occurred_at', 'audit_events_occurred_at_index');
        });
    }

    public function down(): void
    {
        Schema::table('audit_events', function (Blueprint $table): void {
            $table->dropIndex('audit_events_occurred_at_index');
        });
    }
};
