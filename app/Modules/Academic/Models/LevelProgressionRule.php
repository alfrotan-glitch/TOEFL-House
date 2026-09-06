<?php

declare(strict_types=1);

namespace App\Modules\Academic\Models;

use Illuminate\Database\Eloquent\Model;
use Illuminate\Database\Eloquent\Relations\BelongsTo;

/**
 * Program-specific per-level progression rule: optional minimum passing
 * score and maximum repeats. Absence of a rule is never an invented
 * boundary; the Academic decision-maker decides with full audit.
 */
final class LevelProgressionRule extends Model
{
    public const STATE_ACTIVE = 'active';

    public const STATE_RETIRED = 'retired';

    public $incrementing = false;

    protected $keyType = 'string';

    protected $fillable = ['id', 'program_version_level_id', 'minimum_passing_score', 'max_repeats', 'lifecycle_state', 'defined_by'];

    protected $casts = [
        'minimum_passing_score' => 'decimal:2',
        'max_repeats' => 'integer',
    ];

    /** @return BelongsTo<ProgramVersionLevel, $this> */
    public function level(): BelongsTo
    {
        return $this->belongsTo(ProgramVersionLevel::class, 'program_version_level_id');
    }
}
