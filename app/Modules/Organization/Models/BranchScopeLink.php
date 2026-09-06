<?php

declare(strict_types=1);

namespace App\Modules\Organization\Models;

use App\Modules\Identity\Models\Person;
use Illuminate\Database\Eloquent\Model;
use Illuminate\Database\Eloquent\Relations\BelongsTo;

/**
 * Cross-branch affected-scope junction (WP-2 F1). Records that one branch is
 * within the same affected operational scope as another over an effective
 * window, with real foreign keys at both ends and a correlation id linking the
 * change to its audit event. At most one OPEN link may exist per owner branch
 * (partial unique index); closing the prior link appends history and never
 * rewrites it.
 *
 * @property string $id
 * @property string $owner_branch_id
 * @property string $affected_branch_id
 * @property string $effective_from
 * @property string|null $effective_to
 * @property string $lifecycle_state
 * @property string $created_by
 * @property string $correlation_id
 */
final class BranchScopeLink extends Model
{
    public const STATE_ACTIVE = 'active';

    public const STATE_CLOSED = 'closed';

    public $incrementing = false;

    protected $keyType = 'string';

    public $timestamps = false;

    protected $fillable = [
        'id', 'owner_branch_id', 'affected_branch_id', 'effective_from',
        'effective_to', 'lifecycle_state', 'created_by', 'correlation_id', 'created_at',
    ];

    /** @return BelongsTo<Branch, $this> */
    public function ownerBranch(): BelongsTo
    {
        return $this->belongsTo(Branch::class, 'owner_branch_id');
    }

    /** @return BelongsTo<Branch, $this> */
    public function affectedBranch(): BelongsTo
    {
        return $this->belongsTo(Branch::class, 'affected_branch_id');
    }

    /** @return BelongsTo<Person, $this> */
    public function creator(): BelongsTo
    {
        return $this->belongsTo(Person::class, 'created_by');
    }

    public function isOpen(): bool
    {
        return $this->lifecycle_state === self::STATE_ACTIVE && $this->effective_to === null;
    }
}
