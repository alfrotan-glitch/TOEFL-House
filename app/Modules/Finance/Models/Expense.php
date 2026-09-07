<?php

declare(strict_types=1);

namespace App\Modules\Finance\Models;

use Illuminate\Database\Eloquent\Model;

/**
 * Finance-owned operating expense: an approved business cost request with its
 * supplier, purpose, amount, and independent approval. Immutable once
 * approved; the accounting entry is a source-linked journal.
 *
 * @property string $id
 * @property string $period_id
 * @property string $supplier
 * @property string $purpose
 * @property string $category
 * @property numeric-string $amount
 * @property string $source_ref
 * @property string $expense_account_id
 * @property string $lifecycle_state
 * @property string $requested_by
 * @property string|null $approved_by
 * @property string|null $approved_at
 * @property string|null $originating_branch_id
 * @property string|null $current_home_branch_id
 */
final class Expense extends Model
{
    public const STATE_PROPOSED = 'proposed';

    public const STATE_APPROVED = 'approved';

    public $incrementing = false;

    protected $keyType = 'string';

    protected $fillable = [
        'id', 'period_id', 'supplier', 'purpose', 'category', 'amount',
        'source_ref', 'expense_account_id', 'lifecycle_state',
        'requested_by', 'approved_by', 'approved_at',
        'originating_branch_id', 'current_home_branch_id',
    ];

    protected $casts = [
        'approved_at' => 'datetime',
    ];
}
