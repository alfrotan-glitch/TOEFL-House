<?php

declare(strict_types=1);

namespace App\Modules\Organization\Domain;

use App\Modules\Organization\Models\Branch;
use App\Modules\Organization\Models\Campus;
use App\Support\Authorization\StructureScope;
use App\Support\Errors\ValidationError;

/**
 * Resolves the organizational scope of a unit; branch scope follows its
 * currently effective campus attribution.
 */
final class ResolvesStructureScope
{
    public function forCampus(Campus $campus): StructureScope
    {
        return new StructureScope($campus->organization_id, $campus->id);
    }

    public function forBranch(Branch $branch, Campus $activeCampus): StructureScope
    {
        return new StructureScope($activeCampus->organization_id, $activeCampus->id, $branch->id);
    }

    public function forDepartment(string $scopeType, string $scopeId): StructureScope
    {
        if ($scopeType === 'organization') {
            return new StructureScope($scopeId);
        }
        if ($scopeType === 'campus') {
            $campus = Campus::query()->findOrFail($scopeId);

            return $this->forCampus($campus);
        }
        if ($scopeType === 'branch') {
            $branch = Branch::query()->findOrFail($scopeId);
            $assignment = $branch->activeCampusAssignment();
            if ($assignment === null) {
                throw ValidationError::forCode('department.branch_without_campus', 'branch has no effective campus attribution');
            }

            return $this->forBranch($branch, Campus::query()->findOrFail($assignment->campus_id));
        }

        throw ValidationError::forCode('department.scope_type_unknown', sprintf('unknown department scope type %s', $scopeType));
    }
}
