<?php

declare(strict_types=1);

namespace App\Modules\Finance\Models;

use Illuminate\Database\Eloquent\Model;

/**
 * Money received from an external source — an immutable posted fact with a
 * unique external receipt reference (a payment posts only once); returns
 * happen through refunds.
 *
 * @property string $id
 * @property string $period_id
 * @property string $student_id
 * @property string $amount
 * @property string $method
 * @property string $payer_ref
 * @property string $received_on
 * @property string|null $originating_branch_id
 * @property string|null $current_home_branch_id
 */
final class Payment extends Model
{
    public $incrementing = false;

    protected $keyType = 'string';

    protected $fillable = ['id', 'period_id', 'student_id', 'amount', 'method', 'payer_ref', 'received_on', 'recorded_by', 'originating_branch_id', 'current_home_branch_id'];
}
