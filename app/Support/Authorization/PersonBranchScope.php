<?php

declare(strict_types=1);

namespace App\Support\Authorization;

use App\Modules\Identity\Models\Person;
use App\Modules\Organization\Models\Branch;
use App\Support\Errors\BusinessRejection;
use Illuminate\Database\Eloquent\ModelNotFoundException;

/**
 * Resolves the server-owned branch scope for a person-linked operation.
 * Person.home_branch_id is the current identity designation; the branch's
 * active campus assignment supplies organization provenance. Missing,
 * inactive, or incomplete provenance is never treated as a global scope.
 */
final class PersonBranchScope
{
    public static function resolve(string $personId): StructureScope
    {
        $person = Person::query()->whereKey(trim($personId))->first();
        $branchId = $person !== null ? trim((string) ($person->home_branch_id ?? '')) : '';
        $branch = $branchId === '' ? null : Branch::query()->whereKey($branchId)->first();
        if ($person === null || $branch === null || $branch->lifecycle_state !== 'active') {
            throw BusinessRejection::forCode('identity.person_provenance_required', 'person-linked operations require an active home branch');
        }

        try {
            $scope = $branch->structureScope();
        } catch (ModelNotFoundException) {
            throw BusinessRejection::forCode('identity.person_provenance_required', 'person-linked operations require resolvable organization provenance');
        }
        if ($scope->organizationId === '' || $scope->branchId === null) {
            throw BusinessRejection::forCode('identity.person_provenance_required', 'person-linked operations require active organization provenance');
        }

        return $scope;
    }
}
