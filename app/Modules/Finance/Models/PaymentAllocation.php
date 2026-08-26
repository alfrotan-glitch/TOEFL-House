<?php

declare(strict_types=1);

namespace App\Modules\Finance\Models;

use Illuminate\Database\Eloquent\Model;

/**
 * Allocation of one payment to one obligation — exactly one open allocation
 * per pair; immutable history.
 *
 * @property string $id
 * @property string $payment_id
 * @property string $obligation_id
 * @property string $amount
 */
final class PaymentAllocation extends Model
{
    public $incrementing = false;

    protected $keyType = 'string';

    protected $fillable = ['id', 'payment_id', 'obligation_id', 'amount', 'allocated_by'];
}
