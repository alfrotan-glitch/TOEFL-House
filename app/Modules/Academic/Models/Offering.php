<?php

declare(strict_types=1);

namespace App\Modules\Academic\Models;

use App\Modules\Organization\Models\Branch;
use Illuminate\Database\Eloquent\Model;
use Illuminate\Database\Eloquent\Relations\BelongsTo;

/**
 * Offering (WP-2 F3): the concrete "branch runs program-version level L in
 * term T" packaging unit. Exists only when an ACTIVE BranchAvailability matches
 * the same (branch x level x term) and the term is open (schema-enforced).
 *
 * @property string $id
 * @property string $branch_id
 * @property string $program_version_level_id
 * @property string $academic_period_id
 * @property int $capacity
 * @property string $lifecycle_state
 */
final class Offering extends Model
{
    public $incrementing = false;

    protected $keyType = 'string';

    protected $fillable = [
        'id', 'branch_id', 'program_version_level_id', 'academic_period_id', 'capacity', 'lifecycle_state',
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
