<?php

declare(strict_types=1);

namespace App\Modules\Payroll\Models;

use Illuminate\Database\Eloquent\Model;

/**
 * Final employment obligation — an immutable approved result requiring both
 * HR and Finance clearance on a terminated employment.
 *
 * @property string $id
 * @property string $employment_id
 * @property string $amount
 * @property string $basis
 */
final class FinalSettlement extends Model
{
    public $incrementing = false;

    protected $keyType = 'string';

    protected $fillable = ['id', 'employment_id', 'amount', 'basis', 'prepared_by', 'approved_by'];
}
