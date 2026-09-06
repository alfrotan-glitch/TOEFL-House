<?php

declare(strict_types=1);

namespace App\Modules\Academic\Placement\Models;

use Illuminate\Database\Eloquent\Model;
use Illuminate\Database\Eloquent\Relations\BelongsTo;
use Illuminate\Database\Eloquent\Relations\HasMany;

/**
 * A question inside a section. For auto-scored types the server keeps the
 * correct answer (never streamed to a candidate); for productive (essay,
 * speaking) sections the rubric is applied by a marked/scoring step.
 *
 * @property string $id
 * @property string $section_id
 * @property string $code
 * @property string $stem
 * @property string $component
 * @property string $question_type
 * @property string $points
 * @property array<string, mixed>|null $options
 * @property string|null $correct_answer
 * @property string|null $media_ref
 * @property string $lifecycle_state
 */
final class PlacementQuestion extends Model
{
    public $incrementing = false;

    protected $keyType = 'string';

    protected $casts = ['options' => 'array'];

    protected $fillable = [
        'id', 'section_id', 'code', 'stem', 'component', 'question_type', 'points',
        'options', 'correct_answer', 'media_ref', 'lifecycle_state',
    ];

    /** @return BelongsTo<PlacementSection, $this> */
    public function section(): BelongsTo
    {
        return $this->belongsTo(PlacementSection::class, 'section_id');
    }

    /** @return HasMany<PlacementQuestionMedia, $this> */
    public function media(): HasMany
    {
        return $this->hasMany(PlacementQuestionMedia::class, 'question_id');
    }
}
