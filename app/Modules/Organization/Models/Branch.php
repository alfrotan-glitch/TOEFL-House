<?php

declare(strict_types=1);

namespace App\Modules\Organization\Models;

use App\Modules\Organization\Domain\StructureUnit;
use App\Support\Authorization\StructureScope;
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

    public function activeCampusAssignment(): ?CampusAssignment
    {
        /** @var CampusAssignment|null $assignment */
        $assignment = $this->campusAssignments()->whereNull('effective_to')->first();

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
