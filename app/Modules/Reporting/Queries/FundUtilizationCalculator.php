<?php

declare(strict_types=1);

namespace App\Modules\Reporting\Queries;

use App\Modules\Finance\Models\FundingSource;
use App\Modules\Reporting\Domain\MetricCalculator;
use App\Support\Errors\BusinessRejection;
use Illuminate\Support\Facades\DB;

/**
 * Funding utilization (lineage registry): allocated share of a fund's
 * committed pool as-of a financial period's end (agreement/as-of
 * semantics).
 */
final class FundUtilizationCalculator implements MetricCalculator
{
    public function compute(string $periodId, ?string $scopeId): array
    {
        if ($scopeId === null) {
            throw BusinessRejection::forCode('reporting.fund_scope_required', 'fund utilization requires a fund scope');
        }
        /** @var FundingSource|null $fund */
        $fund = FundingSource::query()->find($scopeId);
        if ($fund === null) {
            throw BusinessRejection::forCode('reporting.fund_unknown', 'the scoped fund does not exist');
        }
        $periodEnd = DB::table('financial_periods')->where('id', $periodId)->value('date_to');
        $allocated = (string) DB::table('fund_allocations')
            ->where('fund_id', $fund->id)
            ->whereDate('created_at', '<=', (string) $periodEnd)
            ->sum('amount');

        return ['value' => bcdiv($allocated, (string) $fund->committed_amount, 4), 'meta' => ['allocated' => $allocated, 'committed' => (string) $fund->committed_amount]];
    }
}
