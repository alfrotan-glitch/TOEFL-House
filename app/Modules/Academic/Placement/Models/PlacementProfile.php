<?php

declare(strict_types=1);

namespace App\Modules\Academic\Placement\Models;

use App\Modules\Academic\Models\ClassModel;
use App\Modules\Academic\Models\Offering;
use App\Modules\Academic\Models\ProgramVersion;
use App\Modules\Academic\Models\ProgramVersionLevel;
use App\Modules\Crm\Models\Visitor;
use App\Modules\Identity\Models\Person;
use Illuminate\Database\Eloquent\Model;
use Illuminate\Database\Eloquent\Relations\BelongsTo;
use Illuminate\Database\Eloquent\Relations\HasMany;

/**
 * Person-centric placement decision object. At most one open/live profile
 * exists per person (schema partial unique index); a retake supersedes the
 * current live profile and opens a new one, preserving history.
 *
 * @property string $id
 * @property string $person_id
 * @property string|null $visitor_id
 * @property string|null $program_version_id
 * @property string|null $recommended_level_id
 * @property string|null $recommended_offering_id
 * @property string|null $recommended_class_id
 * @property string|null $overall_cefr_ref
 * @property string $lifecycle_state
 * @property string|null $originating_branch_id
 * @property string|null $current_home_branch_id
 */
final class PlacementProfile extends Model
{
    public const STATE_DRAFT = 'draft';

    public const STATE_SCORED = 'scored';

    public const STATE_RECOMMENDED = 'recommended';

    public const STATE_REVIEWED = 'reviewed';

    public const STATE_APPROVED = 'approved';

    public const STATE_RELEASED = 'released';

    public const STATE_SUPERSEDED = 'superseded';

    public const STATE_RETIRED = 'retired';

    public $incrementing = false;

    protected $keyType = 'string';

    protected $fillable = [
        'id', 'person_id', 'visitor_id', 'program_version_id', 'recommended_level_id',
        'recommended_offering_id', 'recommended_class_id', 'overall_cefr_ref',
        'lifecycle_state', 'originating_branch_id', 'current_home_branch_id',
        'reviewed_by', 'approved_by', 'released_by', 'created_by',
    ];

    /** @return BelongsTo<Person, $this> */
    public function person(): BelongsTo
    {
        return $this->belongsTo(Person::class);
    }

    /** @return BelongsTo<Visitor, $this> */
    public function visitor(): BelongsTo
    {
        return $this->belongsTo(Visitor::class);
    }

    /** @return BelongsTo<ProgramVersion, $this> */
    public function programVersion(): BelongsTo
    {
        return $this->belongsTo(ProgramVersion::class);
    }

    /** @return BelongsTo<ProgramVersionLevel, $this> */
    public function recommendedLevel(): BelongsTo
    {
        return $this->belongsTo(ProgramVersionLevel::class, 'recommended_level_id');
    }

    /** @return BelongsTo<Offering, $this> */
    public function recommendedOffering(): BelongsTo
    {
        return $this->belongsTo(Offering::class, 'recommended_offering_id');
    }

    /** @return BelongsTo<ClassModel, $this> */
    public function recommendedClass(): BelongsTo
    {
        return $this->belongsTo(ClassModel::class, 'recommended_class_id');
    }

    /** @return HasMany<PlacementAttempt, $this> */
    public function attempts(): HasMany
    {
        return $this->hasMany(PlacementAttempt::class, 'profile_id');
    }

    /** @return HasMany<PlacementRecommendation, $this> */
    public function recommendations(): HasMany
    {
        return $this->hasMany(PlacementRecommendation::class, 'profile_id');
    }

    public function isLive(): bool
    {
        return in_array($this->lifecycle_state, [
            self::STATE_DRAFT, self::STATE_SCORED, self::STATE_RECOMMENDED,
            self::STATE_REVIEWED, self::STATE_APPROVED, self::STATE_RELEASED,
        ], true);
    }
}
