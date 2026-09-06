<?php

declare(strict_types=1);

namespace App\Modules\Academic\Placement\Models;

use Illuminate\Database\Eloquent\Model;
use Illuminate\Database\Eloquent\Relations\HasMany;

/**
 * Placement test catalog. Published history is version-scoped so a
 * published test is never silently rewritten.
 *
 * @property string $id
 * @property string $key
 * @property string $name
 * @property string|null $program_version_id
 * @property int $total_time_minutes
 * @property string $scoring_version
 * @property array<string, float> $component_weights
 * @property string $lifecycle_state
 * @property string|null $originating_branch_id
 * @property string|null $current_home_branch_id
 */
final class PlacementTest extends Model
{
    public $incrementing = false;

    protected $keyType = 'string';

    protected $casts = ['component_weights' => 'array'];

    protected $fillable = [
        'id', 'key', 'name', 'program_version_id', 'total_time_minutes', 'scoring_version',
        'component_weights', 'lifecycle_state', 'originating_branch_id', 'current_home_branch_id',
    ];

    /** @return HasMany<PlacementTestVersion, $this> */
    public function versions(): HasMany
    {
        return $this->hasMany(PlacementTestVersion::class, 'placement_test_id');
    }
}
