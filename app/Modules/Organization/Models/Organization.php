<?php

declare(strict_types=1);

namespace App\Modules\Organization\Models;

use App\Modules\Organization\Domain\OrganizationLifecycle;
use App\Modules\Organization\Domain\StructureUnit;
use App\Support\Authorization\StructureScope;
use Illuminate\Database\Eloquent\Model;
use Illuminate\Database\Eloquent\Relations\HasMany;

/**
 * Root of the organization aggregate; owns structure identity and lifecycle.
 *
 * @property string $id
 * @property string $name
 * @property string $lifecycle_state
 */
final class Organization extends Model implements StructureUnit
{
    public $incrementing = false;

    protected $keyType = 'string';

    protected $fillable = ['id', 'name', 'lifecycle_state'];

    /** @return HasMany<Campus, $this> */
    public function campuses(): HasMany
    {
        return $this->hasMany(Campus::class);
    }

    /** @return HasMany<Department, $this> */
    public function departments(): HasMany
    {
        return $this->hasMany(Department::class);
    }

    public function lifecycleState(): string
    {
        return $this->lifecycle_state;
    }

    public function isClosed(): bool
    {
        return $this->lifecycle_state === OrganizationLifecycle::STATE_CLOSED;
    }

    public function structureScope(): StructureScope
    {
        return new StructureScope($this->id);
    }

    public function unitId(): string
    {
        return $this->id;
    }

    public function unitType(): string
    {
        return 'organization';
    }

    public function unitName(): string
    {
        return $this->name;
    }
}
