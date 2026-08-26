<?php

declare(strict_types=1);

namespace App\Modules\Reporting\Queries;

use App\Modules\Reporting\Domain\MetricCalculator;
use Illuminate\Support\Facades\DB;

/**
 * Student balance (lineage registry): posted obligations minus valid
 * allocations and credits — payment allocations, approved discounts, and
 * fund allocations — for one financial period. Recomputed; no manual
 * override.
 */
final class OutstandingBalanceCalculator implements MetricCalculator
{
    public function compute(string $periodId, ?string $scopeId): array
    {
        $bindings = [$periodId];
        $scopeFilter = '';
        if ($scopeId !== null) {
            $scopeFilter = ' AND o.student_id = ?';
            $bindings[] = $scopeId;
        }
        $rows = DB::select(<<<SQL
            SELECT
                COALESCE(SUM(o.original_amount), 0) AS original,
                COALESCE(SUM(a.allocated), 0) AS allocated,
                COALESCE(SUM(d.discounted), 0) AS discounted,
                COALESCE(SUM(f.funded), 0) AS funded
            FROM obligations o
            LEFT JOIN (
                SELECT obligation_id, SUM(amount) AS allocated FROM payment_allocations GROUP BY obligation_id
            ) a ON a.obligation_id = o.id
            LEFT JOIN (
                SELECT obligation_id, SUM(amount) AS discounted FROM discounts WHERE lifecycle_state = 'approved' GROUP BY obligation_id
            ) d ON d.obligation_id = o.id
            LEFT JOIN (
                SELECT l.obligation_id, SUM(fa.amount) AS funded
                FROM fund_allocations fa JOIN obligation_lines l ON l.id = fa.obligation_line_id
                GROUP BY l.obligation_id
            ) f ON f.obligation_id = o.id
            WHERE o.period_id = ?{$scopeFilter}
        SQL, $bindings);
        $row = $rows[0];
        $value = bcsub(bcsub(bcsub((string) $row->original, (string) $row->allocated, 2), (string) $row->discounted, 2), (string) $row->funded, 2);

        return ['value' => $value, 'meta' => ['original' => (string) $row->original, 'allocated' => (string) $row->allocated, 'discounted' => (string) $row->discounted, 'funded' => (string) $row->funded]];
    }
}
