<?php

declare(strict_types=1);

namespace App\Modules\Finance\Models;

use Illuminate\Database\Eloquent\Model;

/**
 * Accountable physical-cash custody ledger. A drawer is opened with a
 * custodian and float, records cash movements, and closes with a counted
 * balance and variance. The running cash is always derived from opening float
 * plus net movements — never stored.
 *
 * @property string $id
 * @property string $organization_id
 * @property string $branch_id
 * @property string $custodian_id
 * @property numeric-string $opening_balance
 * @property numeric-string|null $counted_balance
 * @property numeric-string|null $close_variance
 * @property string|null $close_reason
 * @property string $opened_by
 * @property string $opened_at
 * @property string|null $closed_by
 * @property string|null $closed_at
 * @property string $lifecycle_state
 */
final class CashDrawer extends Model
{
    public const STATE_OPEN = 'open';

    public const STATE_CLOSED = 'closed';

    public $incrementing = false;

    protected $keyType = 'string';

    protected $fillable = [
        'id', 'organization_id', 'branch_id', 'custodian_id', 'opening_balance',
        'counted_balance', 'close_variance', 'close_reason', 'opened_by',
        'opened_at', 'closed_by', 'closed_at', 'lifecycle_state',
    ];

    protected $casts = [
        'opened_at' => 'datetime',
        'closed_at' => 'datetime',
    ];
}
