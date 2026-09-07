<?php

declare(strict_types=1);

namespace App\Modules\Organization\Models;

use App\Modules\Organization\Domain\StructureUnit;
use App\Support\Authorization\StructureScope;
use Carbon\CarbonImmutable;
use Illuminate\Database\Eloquent\Model;
use Illuminate\Database\Eloquent\Relations\HasMany;

/**
 * Branch; its campus attribution over time lives in campus assignments.
 *
 * @property string $id
 * @property string $name
 * @property string $lifecycle_state
 */
final class Branch extends Model implements StructureUnit
{
    public $incrementing = false;

    protected $keyType = 'string';

    protected $fillable = ['id', 'name', 'lifecycle_state'];

    /** @return HasMany<CampusAssignment, $this> */
    public function campusAssignments(): HasMany
    {
        return $this->hasMany(CampusAssignment::class)->orderBy('effective_from');
    }

    public function activeCampusAssignment(?CarbonImmutable $asOf = null): ?CampusAssignment
    {
        $day = ($asOf ?? CarbonImmutable::now())->startOfDay()->toDateString();
        $assignments = $this->campusAssignments()
            ->where('effective_from', '<=', $day)
            ->where(fn ($query) => $query->whereNull('effective_to')->orWhere('effective_to', '>', $day))
            ->reorder('effective_from', 'desc')
            // The exclusion constraint is the concurrency-safe authority,
            // but fail closed for a pre-convergence/malformed database rather
            // than selecting an arbitrary organization root.
            ->limit(2)
            ->get();
        if ($assignments->count() !== 1) {
            return null;
        }

        /** @var CampusAssignment $assignment */
        $assignment = $assignments->first();

        return $assignment;
    }

    public function structureScope(): StructureScope
    {
        $assignment = $this->activeCampusAssignment();
        if ($assignment === null) {
            return new StructureScope('', null, $this->id);
        }
        $campus = Campus::query()->findOrFail($assignment->campus_id);

        return new StructureScope($campus->organization_id, $campus->id, $this->id);
    }

    public function unitId(): string
    {
        return $this->id;
    }

    public function unitType(): string
    {
        return 'branch';
    }

    public function unitName(): string
    {
        return $this->name;
    }

    public function lifecycleState(): string
    {
        return $this->lifecycle_state;
    }
}
