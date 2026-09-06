<?php

declare(strict_types=1);

namespace App\Modules\Organization\Models;

use Illuminate\Database\Eloquent\Model;
use Illuminate\Database\Eloquent\Relations\BelongsTo;

/**
 * Effective-dated campus attribution of a branch. Exactly one open
 * assignment per branch is enforced by a partial unique index; transfers
 * close the prior assignment and never rewrite history.
 *
 * @property string $id
 * @property string $branch_id
 * @property string $campus_id
 * @property string $effective_from
 * @property string|null $effective_to
 * @property string $transfer_correlation_id
 */
final class CampusAssignment extends Model
{
    public $incrementing = false;

    protected $keyType = 'string';

    protected $fillable = [
        'id', 'branch_id', 'campus_id', 'effective_from', 'effective_to', 'transfer_correlation_id',
    ];

    public $timestamps = false;

    /** @return BelongsTo<Branch, $this> */
    public function branch(): BelongsTo
    {
        return $this->belongsTo(Branch::class);
    }

    /** @return BelongsTo<Campus, $this> */
    public function campus(): BelongsTo
    {
        return $this->belongsTo(Campus::class);
    }
}
