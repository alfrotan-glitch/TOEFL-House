<?php

declare(strict_types=1);

namespace App\Modules\Payroll\Models;

use Illuminate\Database\Eloquent\Model;

/**
 * Computed entitlement for one employment in one period: a snapshot of the
 * effective contract configuration and the consumed work evidence. A
 * contract-silent case is HELD, never invented. Recalculation supersedes;
 * history is retained.
 *
 * @property string $id
 * @property string $period_id
 * @property string $employment_id
 * @property string $base_amount
 * @property array<string, mixed> $snapshot
 * @property string $lifecycle_state
 */
final class PayrollCalculation extends Model
{
    public $incrementing = false;

    protected $keyType = 'string';

    protected $fillable = ['id', 'period_id', 'employment_id', 'base_amount', 'snapshot', 'lifecycle_state', 'held_reason', 'prepared_by'];

    protected $casts = ['snapshot' => 'array'];
}
