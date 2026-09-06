<?php

declare(strict_types=1);

namespace App\Modules\Payroll\Models;

use Illuminate\Database\Eloquent\Model;

/**
 * Payroll calculation window with controlled closing; a closed period is
 * immutable and rejects mutation.
 *
 * @property string $id
 * @property string $period_key
 * @property string $date_from
 * @property string $date_to
 * @property string $lifecycle_state
 */
final class PayrollPeriod extends Model
{
    public $incrementing = false;

    protected $keyType = 'string';

    protected $fillable = ['id', 'period_key', 'date_from', 'date_to', 'lifecycle_state'];
}
