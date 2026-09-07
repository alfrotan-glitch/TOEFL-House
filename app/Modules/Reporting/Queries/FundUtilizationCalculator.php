<?php

declare(strict_types=1);

namespace App\Modules\Reporting\Queries;

use App\Modules\Finance\Models\FinancialPeriod;
use App\Modules\Finance\Models\FundingSource;
use App\Modules\Organization\Models\Organization;
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
        $organizationId = trim((string) ($fund?->organization_id ?? ''));
        if ($fund === null || $organizationId === '' || ! Organization::query()
            ->whereKey($organizationId)
            ->where('lifecycle_state', 'active')
            ->exists()) {
            // The calculator can also be invoked by internal rebuild jobs.
            // It must not turn a legacy, unlabeled Finance source into an
            // unscoped report merely because a caller skipped ReportingScope.
            throw BusinessRejection::forCode('reporting.fund_unknown', 'the scoped fund requires active organization provenance');
        }
        $periodEnd = FinancialPeriod::query()->whereKey($periodId)->value('date_to');
        if ($periodEnd === null) {
            throw BusinessRejection::forCode('reporting.period_unknown', 'the financial period does not exist');
        }
        $result = ($this->balances ?? new FinancialBalanceQuery())->fundUtilization($fund, (string) $periodEnd);

        return ['value' => $result['utilization'], 'meta' => [
            'allocated' => $result['allocated'], 'committed' => $result['committed'],
            'organization_id' => $organizationId,
        ]];
    }
}
