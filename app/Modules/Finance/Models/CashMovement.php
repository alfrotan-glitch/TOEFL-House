<?php

declare(strict_types=1);

namespace App\Modules\Finance\Models;

use Illuminate\Database\Eloquent\Model;

/**
 * One cash in/out movement against a cash drawer. Immutable custody history;
 * a physical draw can never exceed the cash currently in the drawer.
 *
 * @property string $id
 * @property string $drawer_id
 * @property string $type
 * @property numeric-string $amount
 * @property string $reason
 * @property string $recorded_by
 * @property string $occurred_at
 */
final class CashMovement extends Model
{
    public const TYPE_IN = 'in';

    public const TYPE_OUT = 'out';

    public $incrementing = false;

    protected $keyType = 'string';

    protected $fillable = [
        'id', 'drawer_id', 'type', 'amount', 'reason', 'recorded_by', 'occurred_at',
    ];

    protected $casts = [
        'occurred_at' => 'datetime',
    ];
}
