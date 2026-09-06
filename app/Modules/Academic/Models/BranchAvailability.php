<?php

declare(strict_types=1);

namespace App\Modules\Academic\Models;

use App\Modules\Organization\Models\Branch;
use Illuminate\Database\Eloquent\Model;
use Illuminate\Database\Eloquent\Relations\BelongsTo;
use Illuminate\Database\Eloquent\Relations\HasMany;

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

    public const STATE_CLOSED = 'closed';

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

    /** @return BelongsTo<AcademicPeriod, $this> */
    public function period(): BelongsTo
    {
        return $this->belongsTo(AcademicPeriod::class, 'academic_period_id');
    }

    /** @return HasMany<Offering, $this> */
    public function offerings(): HasMany
    {
        return $this->hasMany(Offering::class, 'branch_id', 'branch_id')
            ->whereColumn('offerings.program_version_level_id', 'branch_availabilities.program_version_level_id')
            ->whereColumn('offerings.academic_period_id', 'branch_availabilities.academic_period_id');
    }
}
