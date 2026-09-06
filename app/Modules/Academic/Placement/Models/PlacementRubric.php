<?php

declare(strict_types=1);

namespace App\Modules\Academic\Placement\Models;

use Illuminate\Database\Eloquent\Model;
use Illuminate\Database\Eloquent\Relations\BelongsTo;

/**
 * Rubric band: an inclusive score range on one component maps to a CEFR
 * reference and an explainable descriptor.
 *
 * @property string $id
 * @property string $test_version_id
 * @property string $component
 * @property string $band
 * @property string $min_score
 * @property string $max_score
 * @property string $cefr_ref
 * @property string $description
 * @property string $lifecycle_state
 */
final class PlacementRubric extends Model
{
    public $incrementing = false;

    protected $keyType = 'string';

    protected $fillable = [
        'id', 'test_version_id', 'component', 'band', 'min_score', 'max_score',
        'cefr_ref', 'description', 'lifecycle_state',
    ];

    /** @return BelongsTo<PlacementTestVersion, $this> */
    public function version(): BelongsTo
    {
        return $this->belongsTo(PlacementTestVersion::class, 'test_version_id');
    }

    public function containsScore(float $score): bool
    {
        return $score >= (float) $this->min_score && $score <= (float) $this->max_score;
    }
}
