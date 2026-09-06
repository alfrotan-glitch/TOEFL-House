<?php

declare(strict_types=1);

namespace App\Modules\Reporting\Queries;

use App\Modules\Finance\Models\FinancialPeriod;
use App\Modules\Finance\Models\FundingSource;
use App\Modules\Finance\Queries\FinancialBalanceQuery;
use App\Modules\Reporting\Domain\MetricCalculator;
use App\Support\Errors\BusinessRejection;

/**
 * Reporting adapter for Finance's fund utilization calculation. Corrections
 * and as-of semantics stay in Finance rather than being duplicated here.
 */
final class FundUtilizationCalculator implements MetricCalculator
{
    public function __construct(private readonly ?FinancialBalanceQuery $balances = null) {}

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
        $periodEnd = FinancialPeriod::query()->whereKey($periodId)->value('date_to');
        if ($periodEnd === null) {
            throw BusinessRejection::forCode('reporting.period_unknown', 'the financial period does not exist');
        }
        $result = ($this->balances ?? new FinancialBalanceQuery())->fundUtilization($fund, (string) $periodEnd);

        return ['value' => $result['utilization'], 'meta' => [
            'allocated' => $result['allocated'], 'committed' => $result['committed'],
        ]];
    }
}
