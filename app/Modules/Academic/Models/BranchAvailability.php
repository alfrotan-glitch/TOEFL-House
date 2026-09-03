<?php

declare(strict_types=1);

namespace App\Modules\Academic\Models;

use App\Modules\Organization\Models\Branch;
use Illuminate\Database\Eloquent\Model;
use Illuminate\Database\Eloquent\Relations\BelongsTo;

/**
 * BranchAvailability (WP-2 F3): a branch declares it will run a program-version
 * level in an academic term. Co-dependent with Offerings — an Offering exists
 * only for an ACTIVE availability triple (branch x level x term).
 *
 * @property string $id
 * @property string $branch_id
 * @property string $program_version_level_id
 * @property string $academic_period_id
 * @property string $lifecycle_state
 */
final class BranchAvailability extends Model
{
    public const STATE_ACTIVE = 'active';

    public $incrementing = false;

    protected $keyType = 'string';

    protected $fillable = [
        'id', 'branch_id', 'program_version_level_id', 'academic_period_id', 'lifecycle_state',
    ];

    /** @return BelongsTo<Branch, $this> */
    public function branch(): BelongsTo
    {
        return $this->belongsTo(Branch::class);
    }

    /** @return BelongsTo<ProgramVersionLevel, $this> */
    public function level(): BelongsTo
    {
        return $this->belongsTo(ProgramVersionLevel::class, 'program_version_level_id');
    }
}
