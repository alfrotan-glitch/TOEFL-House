<?php

declare(strict_types=1);

namespace App\Modules\Academic\Placement\Models;

use Illuminate\Database\Eloquent\Model;
use Illuminate\Database\Eloquent\Relations\BelongsTo;

/**
 * Calculated section result (auto or professional) through the staged
 * scored -> moderated -> approved chain.
 *
 * @property string $id
 * @property string $attempt_id
 * @property string $section_id
 * @property string $component
 * @property string|null $raw_score
 * @property string|null $adjusted_score
 * @property string|null $weighted_score
 * @property string|null $rubric_id
 * @property string|null $cefr_ref
 * @property string $lifecycle_state
 * @property string $scored_by
 * @property string|null $moderated_by
 * @property string|null $approved_by
 */
final class PlacementSectionResult extends Model
{
    public const STATE_SCORED = 'scored';

    public const STATE_MODERATED = 'moderated';

    public const STATE_APPROVED = 'approved';

    public $incrementing = false;

    protected $keyType = 'string';

    protected $fillable = [
        'id', 'attempt_id', 'section_id', 'component', 'raw_score', 'adjusted_score',
        'weighted_score', 'rubric_id', 'cefr_ref', 'lifecycle_state', 'scored_by',
        'moderated_by', 'approved_by', 'rationale',
    ];

    /** @return BelongsTo<PlacementAttempt, $this> */
    public function attempt(): BelongsTo
    {
        return $this->belongsTo(PlacementAttempt::class, 'attempt_id');
    }

    /** @return BelongsTo<PlacementSection, $this> */
    public function section(): BelongsTo
    {
        return $this->belongsTo(PlacementSection::class, 'section_id');
    }

    /** @return BelongsTo<PlacementRubric, $this> */
    public function rubric(): BelongsTo
    {
        return $this->belongsTo(PlacementRubric::class, 'rubric_id');
    }
}
