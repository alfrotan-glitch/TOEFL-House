<?php

declare(strict_types=1);

namespace App\Modules\Reporting\Queries;

use App\Modules\Finance\Queries\FinancialBalanceQuery;
use App\Modules\Reporting\Domain\MetricCalculator;

/**
 * Reporting adapter for the Finance-owned balance authority. Reporting may
 * aggregate and present the result, but it does not reproduce settlement
 * arithmetic from raw financial tables.
 */
final class OutstandingBalanceCalculator implements MetricCalculator
{
    public function __construct(private readonly ?FinancialBalanceQuery $balances = null) {}

    public function compute(string $periodId, ?string $scopeId): array
    {
        $result = ($this->balances ?? new FinancialBalanceQuery())->periodBalance($periodId, $scopeId);

        return $result;
    }
}
