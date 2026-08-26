<?php

declare(strict_types=1);

namespace App\Modules\Finance\Models;

use Illuminate\Database\Eloquent\Model;

/**
 * Authorized return of received money — references its immutable source
 * payment, never exceeds the refundable remainder, immutable once approved.
 *
 * @property string $id
 * @property string $payment_id
 * @property string $period_id
 * @property string $amount
 * @property string $reason
 */
final class Refund extends Model
{
    public $incrementing = false;

    protected $keyType = 'string';

    protected $fillable = ['id', 'payment_id', 'period_id', 'amount', 'reason', 'requested_by', 'approved_by'];
}
