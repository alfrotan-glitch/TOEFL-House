<?php

declare(strict_types=1);

namespace App\Modules\Organization\Models;

use App\Modules\Organization\Domain\StructureUnit;
use App\Support\Authorization\StructureScope;
use Illuminate\Database\Eloquent\Model;
use Illuminate\Database\Eloquent\Relations\BelongsTo;
use Illuminate\Database\Eloquent\Relations\HasMany;

/**
 * Campus within exactly one organization.
 *
 * @property string $id
 * @property string $organization_id
 * @property string $name
 * @property string $lifecycle_state
 */
final class Campus extends Model implements StructureUnit
{
    public $incrementing = false;

    protected $keyType = 'string';

    protected $fillable = ['id', 'organization_id', 'name', 'lifecycle_state'];

    /** @return BelongsTo<Organization, $this> */
    public function organization(): BelongsTo
    {
        return $this->belongsTo(Organization::class);
    }

    /** @return HasMany<CampusAssignment, $this> */
    public function branchAssignments(): HasMany
    {
        return $this->hasMany(CampusAssignment::class);
    }

    public function structureScope(): StructureScope
    {
        return new StructureScope($this->organization_id, $this->id);
    }

    public function unitId(): string
    {
        return $this->id;
    }

    public function unitType(): string
    {
        return 'campus';
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
