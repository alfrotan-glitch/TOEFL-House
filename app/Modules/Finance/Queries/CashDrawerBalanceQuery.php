<?php

declare(strict_types=1);

namespace App\Modules\Finance\Queries;

use App\Modules\Finance\Models\CashDrawer;
use App\Modules\Finance\Models\CashMovement;
use App\Support\MoneyAmount;

/**
 * Cash-drawer derived balance authority. The physical cash in a drawer is
 * always derived from the opening float plus net movements — never stored —
 * so closing a drawer compares an independent count to this projection.
 */
final class CashDrawerBalanceQuery
{
    /** @return numeric-string */
    public function currentCash(CashDrawer $drawer): string
    {
        $opening = MoneyAmount::decimal((string) $drawer->opening_balance);
        $in = MoneyAmount::decimal((string) (CashMovement::query()
            ->where('drawer_id', $drawer->id)
            ->where('type', CashMovement::TYPE_IN)
            ->sum('amount') ?? '0'));
        $out = MoneyAmount::decimal((string) (CashMovement::query()
            ->where('drawer_id', $drawer->id)
            ->where('type', CashMovement::TYPE_OUT)
            ->sum('amount') ?? '0'));

        return bcadd(bcsub($opening, $out, 2), $in, 2);
    }
}
