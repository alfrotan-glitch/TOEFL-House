<?php

declare(strict_types=1);

namespace App\Modules\Hr\Models;

use Illuminate\Database\Eloquent\Model;

/**
 * Effective-dated contractual entitlement (fixed, hourly, class-based, or
 * allowance per contract); immutable once active — a change is a new
 * effective-dated component.
 *
 * @property string $id
 * @property string $contract_id
 * @property string $kind
 * @property string $amount
 * @property string $effective_from
 * @property string|null $effective_to
 * @property string $lifecycle_state
 */
final class CompensationComponent extends Model
{
    public $incrementing = false;

    protected $keyType = 'string';

    protected $fillable = ['id', 'contract_id', 'kind', 'amount', 'effective_from', 'effective_to', 'lifecycle_state', 'proposed_by', 'approved_by'];
}
