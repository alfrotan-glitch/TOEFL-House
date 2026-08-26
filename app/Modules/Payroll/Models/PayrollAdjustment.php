<?php

declare(strict_types=1);

namespace App\Modules\Payroll\Models;

use Illuminate\Database\Eloquent\Model;

/**
 * Source-linked approved correction (adjustment or reversal); append-only
 * history.
 *
 * @property string $id
 * @property string $result_id
 * @property string $kind
 * @property string $amount
 * @property string $reason
 */
final class PayrollAdjustment extends Model
{
    public $incrementing = false;

    protected $keyType = 'string';

    protected $fillable = ['id', 'result_id', 'kind', 'amount', 'reason', 'approved_by'];
}
