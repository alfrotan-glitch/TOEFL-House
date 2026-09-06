<?php

declare(strict_types=1);

namespace App\Modules\Finance\Models;

use Illuminate\Database\Eloquent\Model;

/**
 * Authorized return of received money — references its immutable source
 * payment, is born proposed (requester session), becomes recorded only
 * through a distinct approver's session, never exceeds the refundable
 * remainder, and is immutable once recorded.
 *
 * @property string $id
 * @property string $payment_id
 * @property string $period_id
 * @property string $amount
 * @property string $reason
 * @property string $requested_by
 * @property string|null $approved_by
 * @property string $lifecycle_state
 * @property string|null $originating_branch_id
 * @property string|null $current_home_branch_id
 */
final class Refund extends Model
{
    public $incrementing = false;

    protected $keyType = 'string';

    protected $fillable = ['id', 'payment_id', 'period_id', 'amount', 'reason', 'requested_by', 'approved_by', 'lifecycle_state', 'originating_branch_id', 'current_home_branch_id'];
}
