<?php

declare(strict_types=1);

namespace App\Modules\Academic\Placement\Models;

use Illuminate\Database\Eloquent\Model;
use Illuminate\Database\Eloquent\Relations\BelongsTo;
use Illuminate\Database\Eloquent\Relations\HasMany;

/**
 * Immutable published version of a placement test; corrections publish a
 * new version instead of rewriting one.
 *
 * @property string $id
 * @property string $placement_test_id
 * @property int $version_no
 * @property string $summary
 * @property string $lifecycle_state
 */
final class PlacementTestVersion extends Model
{
    public $incrementing = false;

    protected $keyType = 'string';

    protected $fillable = ['id', 'placement_test_id', 'version_no', 'summary', 'lifecycle_state', 'published_at'];

    /** @return BelongsTo<PlacementTest, $this> */
    public function test(): BelongsTo
    {
        return $this->belongsTo(PlacementTest::class, 'placement_test_id');
    }

    /** @return HasMany<PlacementSection, $this> */
    public function sections(): HasMany
    {
        return $this->hasMany(PlacementSection::class, 'test_version_id');
    }

    /** @return HasMany<PlacementRubric, $this> */
    public function rubrics(): HasMany
    {
        return $this->hasMany(PlacementRubric::class, 'test_version_id');
    }
}
