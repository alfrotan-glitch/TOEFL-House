<?php

declare(strict_types=1);

namespace Tests\Feature\Reliability;

use Illuminate\Support\Facades\DB;
use Tests\TestCase;

/**
 * PHASE_4 performance guard: the audit console lists the append-only audit
 * trail newest-first (ORDER BY occurred_at DESC). That sort is index-backed
 * (audit_events_occurred_at_index, 000118) — if the index disappears, the
 * listing degrades to a sequential scan + top-N sort that grows with
 * history. This test pins the schema contract (planner-dependent timings
 * are not asserted here; they are measured evidence in the assurance doc).
 */
final class AuditTrailIndexTest extends TestCase
{
    public function test_the_audit_trail_listing_sort_is_index_backed(): void
    {
        $table = DB::connection()->getTablePrefix().'audit_events';
        $index = DB::selectOne('SELECT indexdef FROM pg_indexes WHERE tablename = ? AND indexname = ?', [
            $table,
            'audit_events_occurred_at_index',
        ]);
        $this->assertNotNull($index, 'audit_events_occurred_at_index is missing');
        $this->assertStringContainsString('occurred_at', (string) $index->indexdef);
    }
}
