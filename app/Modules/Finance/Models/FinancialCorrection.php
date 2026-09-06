<?php

declare(strict_types=1);

namespace App\Modules\Finance\Models;

use Illuminate\Database\Eloquent\Model;

/**
 * Finance-owned compensating fact. Source financial rows are never edited;
 * this row records the signed correction and its independent approval.
 */
final class FinancialCorrection extends Model
{
    public const TYPE_OBLIGATION_ADJUSTMENT = 'obligation_adjustment';

    public const TYPE_ALLOCATION_REVERSAL = 'allocation_reversal';

    public const TYPE_FUND_ALLOCATION_REVERSAL = 'fund_allocation_reversal';

    public const DIRECTION_DECREASE = 'decrease';

    public const DIRECTION_INCREASE = 'increase';

    public const STATE_PROPOSED = 'proposed';

    public const STATE_RECORDED = 'recorded';

    public $incrementing = false;

    protected $keyType = 'string';

    protected $fillable = [
        'id', 'period_id', 'correction_type', 'obligation_id', 'payment_allocation_id', 'fund_allocation_id',
        'amount', 'direction', 'reason', 'lifecycle_state', 'requested_by',
        'approved_by', 'approved_at',
    ];
}
