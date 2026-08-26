<?php

declare(strict_types=1);

namespace App\Modules\Finance\Models;

use Illuminate\Database\Eloquent\Model;

/**
 * Controlled posting/reporting window; closed periods are immutable and
 * reject mutation.
 *
 * @property string $id
 * @property string $period_key
 * @property string $date_from
 * @property string $date_to
 * @property string $lifecycle_state
 */
final class FinancialPeriod extends Model
{
    public $incrementing = false;

    protected $keyType = 'string';

    protected $fillable = ['id', 'period_key', 'date_from', 'date_to', 'lifecycle_state', 'closed_by'];
}
