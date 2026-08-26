<?php

declare(strict_types=1);

namespace App\Modules\Finance\Models;

use Illuminate\Database\Eloquent\Model;

/**
 * Approved reduction of an obligation with eligibility, effective dates,
 * and audit; the original charge is preserved — never rewritten.
 *
 * @property string $id
 * @property string $obligation_id
 * @property string $period_id
 * @property string $amount
 * @property string $eligibility
 * @property string $effective_from
 * @property string|null $effective_to
 * @property string $lifecycle_state
 */
final class Discount extends Model
{
    public $incrementing = false;

    protected $keyType = 'string';

    protected $fillable = ['id', 'obligation_id', 'period_id', 'amount', 'eligibility', 'effective_from', 'effective_to', 'reason', 'lifecycle_state', 'proposed_by', 'approved_by'];
}
