<?php

declare(strict_types=1);

namespace App\Modules\Academic\Placement\Models;

use App\Modules\Academic\Models\ProgramVersionLevel;
use Illuminate\Database\Eloquent\Model;
use Illuminate\Database\Eloquent\Relations\BelongsTo;

/**
 * Immutable, explainable recommendation. The current recommendation is
 * pointed to by the placement profile; a later retake appends a new row.
 *
 * @property string $id
 * @property string $profile_id
 * @property string $recommended_level_id
 * @property string|null $recommended_class_id
 * @property string|null $recommended_offering_id
 * @property string $rationale
 * @property string $model_version
 * @property array<string, mixed> $score_snapshot
 * @property string $recommended_by
 */
final class PlacementRecommendation extends Model
{
    public $incrementing = false;

    protected $keyType = 'string';

    protected $casts = ['score_snapshot' => 'array'];

    protected $fillable = [
        'id', 'profile_id', 'recommended_level_id', 'recommended_class_id',
        'recommended_offering_id', 'rationale', 'model_version', 'score_snapshot',
        'recommended_by',
    ];

    /** @return BelongsTo<PlacementProfile, $this> */
    public function profile(): BelongsTo
    {
        return $this->belongsTo(PlacementProfile::class, 'profile_id');
    }

    /** @return BelongsTo<ProgramVersionLevel, $this> */
    public function level(): BelongsTo
    {
        return $this->belongsTo(ProgramVersionLevel::class, 'recommended_level_id');
    }
}
