<?php

declare(strict_types=1);

namespace App\Modules\Finance\Models;

use Illuminate\Database\Eloquent\Model;

/**
 * Money origin and pool under an agreement — immutable once established;
 * a restriction is never reclassified and utilization is derived from
 * allocations, never stored.
 *
 * @property string $id
 * @property string $name
 * @property string $agreement_ref
 * @property string $committed_amount
 * @property string|null $restricted_category
 */
final class FundingSource extends Model
{
    public $incrementing = false;

    protected $keyType = 'string';

    protected $fillable = ['id', 'name', 'agreement_ref', 'committed_amount', 'restricted_category', 'restriction_note', 'established_by'];
}
