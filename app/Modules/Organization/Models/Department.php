<?php

declare(strict_types=1);

namespace App\Modules\Organization\Models;

use App\Modules\Organization\Domain\ResolvesStructureScope;
use App\Modules\Organization\Domain\StructureUnit;
use App\Support\Authorization\StructureScope;
use Illuminate\Database\Eloquent\Model;

/**
 * Department unit scoped to exactly one structural owner: organization,
 * campus, or branch.
 *
 * @property string $id
 * @property string $name
 * @property string $lifecycle_state
 * @property string $scope_type
 * @property string $scope_id
 */
final class Department extends Model implements StructureUnit
{
    public $incrementing = false;

    protected $keyType = 'string';

    protected $fillable = ['id', 'name', 'lifecycle_state', 'scope_type', 'scope_id'];

    public function scopeType(): string
    {
        return $this->scope_type;
    }

    public function structureScope(): StructureScope
    {
        return (new ResolvesStructureScope)->forDepartment($this->scope_type, $this->scope_id);
    }

    public function unitId(): string
    {
        return $this->id;
    }

    public function unitType(): string
    {
        return 'department';
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
