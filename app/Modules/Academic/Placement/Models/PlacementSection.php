<?php

declare(strict_types=1);

namespace App\Modules\Academic\Placement\Models;

use App\Modules\Academic\Placement\Domain\PlacementComponent;
use Illuminate\Database\Eloquent\Model;
use Illuminate\Database\Eloquent\Relations\BelongsTo;
use Illuminate\Database\Eloquent\Relations\HasMany;

/**
 * One section of a placement test version, scoped to exactly one of the
 * five canonical components.
 *
 * @property string $id
 * @property string $test_version_id
 * @property string $code
 * @property string $name
 * @property string $component
 * @property int $section_order
 * @property int $time_minutes
 * @property string $delivery_mode
 * @property bool $can_auto_score
 * @property string $lifecycle_state
 */
final class PlacementSection extends Model
{
    public $incrementing = false;

    protected $keyType = 'string';

    protected $fillable = [
        'id', 'test_version_id', 'code', 'name', 'component', 'section_order',
        'time_minutes', 'delivery_mode', 'can_auto_score', 'lifecycle_state',
    ];

    /** @return BelongsTo<PlacementTestVersion, $this> */
    public function version(): BelongsTo
    {
        return $this->belongsTo(PlacementTestVersion::class, 'test_version_id');
    }

    /** @return HasMany<PlacementQuestion, $this> */
    public function questions(): HasMany
    {
        return $this->hasMany(PlacementQuestion::class, 'section_id');
    }

    public function componentLabel(): string
    {
        return PlacementComponent::label($this->component);
    }
}
