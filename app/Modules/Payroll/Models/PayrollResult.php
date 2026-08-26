<?php

declare(strict_types=1);

namespace App\Modules\Payroll\Models;

use Illuminate\Database\Eloquent\Model;

/**
 * Approved payable result — immutable once approved; corrections and
 * reversals append adjustments instead of overwriting.
 *
 * @property string $id
 * @property string $calculation_id
 * @property string $period_id
 * @property string $employment_id
 * @property string $amount
 * @property string $lifecycle_state
 */
final class PayrollResult extends Model
{
    public $incrementing = false;

    protected $keyType = 'string';

    protected $fillable = ['id', 'calculation_id', 'period_id', 'employment_id', 'amount', 'lifecycle_state', 'approved_by'];
}
