<?php

declare(strict_types=1);

namespace App\Modules\Academic\Models;

use Illuminate\Database\Eloquent\Model;
use Illuminate\Database\Eloquent\Relations\BelongsTo;

/**
 * Academic prerequisite configuration: an active target level requires a
 * prior level of the same program version. Configured, version-scoped,
 * audited; it never advances a student.
 */
final class LevelPrerequisite extends Model
{
    public const STATE_ACTIVE = 'active';

    public const STATE_RETIRED = 'retired';

    public $incrementing = false;

    protected $keyType = 'string';

    protected $fillable = ['id', 'target_level_id', 'required_level_id', 'lifecycle_state', 'defined_by'];

    /** @return BelongsTo<ProgramVersionLevel, $this> */
    public function targetLevel(): BelongsTo
    {
        return $this->belongsTo(ProgramVersionLevel::class, 'target_level_id');
    }

    /** @return BelongsTo<ProgramVersionLevel, $this> */
    public function requiredLevel(): BelongsTo
    {
        return $this->belongsTo(ProgramVersionLevel::class, 'required_level_id');
    }
}
