<?php

declare(strict_types=1);

namespace App\Support\Authorization;

use App\Modules\Access\Domain\AccessLifecycle;
use App\Modules\Access\Models\Delegation;
use App\Modules\Hr\Models\Employment;
use App\Modules\Hr\Domain\EmploymentLifecycle;
use App\Modules\Access\Models\Position;
use App\Modules\Access\Models\PositionAssignment;
use App\Modules\Access\Models\ScopeGrant;
use App\Modules\Organization\Models\Branch;
use App\Modules\Organization\Models\Campus;
use App\Modules\Organization\Models\CampusAssignment;
use App\Modules\Organization\Models\Department;
use Carbon\CarbonImmutable;

/**
 * Read-side branch visibility (WP-ACAD-SCOPE): the set of branches an actor
 * may be shown, derived from the SAME canonical access model as writes —
 * active scope grants (branch / campus / department / organization),
 * role-derived organizations, and scoped delegations, mapped through the
 * campus-assignment topology. Date/window semantics mirror
 * AccessResolution exactly; unscoped delegations and unmappable department
 * scopes contribute nothing (fail-closed).
 */
final class ActorBranches
{
    public function __construct(private readonly ?CarbonImmutable $effectiveTime = null) {}

    /** @return list<string> sorted unique branch ids */
    public function visibleBranchIds(Actor $actor): array
    {
        if (trim($actor->actorId) === '' || ! $this->employmentEligible($actor->actorId)) {
            return [];
        }
        $today = ($this->effectiveTime ?? CarbonImmutable::now())->startOfDay()->toDateString();
        $branches = [];
        foreach ($this->activeGrantScopes($actor->actorId, $today) as [$scopeType, $scopeId]) {
            foreach ($this->branchesForScope($scopeType, $scopeId, $today) as $branchId) {
                $branches[] = $branchId;
            }
        }
        foreach ($this->roleOrganizationIds($actor->actorId, $today) as $organizationId) {
            foreach ($this->branchesForOrganization($organizationId, $today) as $branchId) {
                $branches[] = $branchId;
            }
        }
        $branches = array_values(array_unique($branches, SORT_STRING));
        $branches = $this->operationalBranchIds($branches, $today);
        sort($branches);

        return $branches;
    }

    /**
     * Whether the actor has an effective branch-scoped read surface. A role,
     * position, or delegation by itself is not proof of any capability or
     * topology, so branchless authority is deliberately not inferred here.
     * Organization-wide reads must call AccessResolution for their concrete
     * capability and organization scope.
     */
    public function hasAnyAuthority(Actor $actor): bool
    {
        return $this->visibleBranchIds($actor) !== [];
    }

    /** Null branch is unknown provenance, never a wildcard visibility grant. */
    public function allows(Actor $actor, ?string $branchId): bool
    {
        $branchId = trim((string) ($branchId ?? ''));
        if ($branchId === '') {
            return false;
        }

        return in_array($branchId, $this->visibleBranchIds($actor), true);
    }

    /** @return list<array{0: string, 1: string}> */
    private function activeGrantScopes(string $personId, string $today): array
    {
        $scopes = ScopeGrant::query()
            ->where('person_id', $personId)
            ->where('lifecycle_state', AccessLifecycle::STATE_ACTIVE)
            ->where('effective_from', '<=', $today)
            ->where(fn ($query) => $query->whereNull('effective_to')->orWhere('effective_to', '>', $today))
            ->get(['scope_type', 'scope_id'])
            ->map(static fn ($grant): array => [trim((string) $grant->scope_type), trim((string) $grant->scope_id)])
            ->all();

        $delegations = Delegation::query()
            ->where('delegate_person_id', $personId)
            ->where('lifecycle_state', AccessLifecycle::STATE_ACTIVE)
            ->where('effective_from', '<=', $today)
            ->where('effective_to', '>', $today)
            ->get(['scope_type', 'scope_id']);
        foreach ($delegations as $delegation) {
            $scopeType = trim((string) ($delegation->scope_type ?? ''));
            $scopeId = trim((string) ($delegation->scope_id ?? ''));
            if ($scopeType === '' || $scopeId === '') {
                continue;
            }
            $scopes[] = [$scopeType, $scopeId];
        }

        return $scopes;
    }

    /** @return list<string> */
    private function roleOrganizationIds(string $personId, string $today): array
    {
        $positionIds = PositionAssignment::query()
            ->where('person_id', $personId)
            ->where('lifecycle_state', AccessLifecycle::STATE_ACTIVE)
            ->where('effective_from', '<=', $today)
            ->where(fn ($query) => $query->whereNull('effective_to')->orWhere('effective_to', '>', $today))
            ->pluck('position_id')
            ->map(static fn ($value): string => trim((string) $value))
            ->all();

        if ($positionIds === []) {
            return [];
        }

        return Position::query()
            ->whereIn('id', $positionIds)
            ->pluck('organization_id')
            ->map(static fn ($value): string => trim((string) $value))
            ->filter(static fn (string $value): bool => $value !== '')
            ->values()
            ->all();
    }

    /** @return list<string> */
    private function branchesForScope(string $scopeType, string $scopeId, string $day): array
    {
        if ($scopeId === '') {
            return [];
        }

        return match ($scopeType) {
            'branch' => [$scopeId],
            'campus' => $this->branchesForCampus($scopeId, $day),
            'department' => $this->branchesForDepartment($scopeId, $day),
            'organization' => $this->branchesForOrganization($scopeId, $day),
            default => [],
        };
    }

    /** @return list<string> */
    private function branchesForCampus(string $campusId, string $day): array
    {
        return CampusAssignment::query()
            ->where('campus_id', $campusId)
            ->where('effective_from', '<=', $day)
            ->where(fn ($query) => $query->whereNull('effective_to')->orWhere('effective_to', '>', $day))
            ->pluck('branch_id')
            ->map(static fn ($value): string => trim((string) $value))
            ->filter(static fn (string $value): bool => $value !== '')
            ->values()
            ->all();
    }

    /** @return list<string> */
    private function branchesForDepartment(string $departmentId, string $day): array
    {
        /** @var Department|null $department */
        $department = Department::query()->find($departmentId);
        if ($department === null || $department->lifecycle_state !== 'active') {
            return [];
        }
        $scopeType = trim((string) ($department->scope_type ?? ''));
        $scopeId = trim((string) ($department->scope_id ?? ''));
        if ($scopeType === 'branch' && $scopeId !== '') {
            return [$scopeId];
        }
        if ($scopeType === 'campus' && $scopeId !== '') {
            return $this->branchesForCampus($scopeId, $day);
        }

        return [];
    }

    /** @return list<string> */
    private function branchesForOrganization(string $organizationId, string $day): array
    {
        $campusIds = Campus::query()
            ->where('organization_id', $organizationId)
            ->pluck('id')
            ->map(static fn ($value): string => trim((string) $value))
            ->all();
        if ($campusIds === []) {
            return [];
        }

        return CampusAssignment::query()
            ->whereIn('campus_id', $campusIds)
            ->where('effective_from', '<=', $day)
            ->where(fn ($query) => $query->whereNull('effective_to')->orWhere('effective_to', '>', $day))
            ->pluck('branch_id')
            ->map(static fn ($value): string => trim((string) $value))
            ->filter(static fn (string $value): bool => $value !== '')
            ->values()
            ->all();
    }

    private function employmentEligible(string $personId): bool
    {
        $hasEmployment = Employment::query()->where('person_id', $personId)->exists();
        if (! $hasEmployment) {
            return true;
        }

        /** @var Employment|null $current */
        $current = Employment::query()
            ->where('person_id', $personId)
            ->orderByDesc('created_at')
            ->orderByDesc('id')
            ->first();

        return $current !== null && $current->lifecycle_state === EmploymentLifecycle::STATE_ACTIVE;
    }

    /** @param list<string> $branchIds
     *  @return list<string>
     */
    private function operationalBranchIds(array $branchIds, string $day): array
    {
        if ($branchIds === []) {
            return [];
        }

        return Branch::query()
            ->join('campus_assignments as visible_ca', function ($join) use ($day): void {
                $join->on('visible_ca.branch_id', '=', 'branches.id')
                    ->where('visible_ca.effective_from', '<=', $day)
                    ->where(function ($query) use ($day): void {
                        $query->whereNull('visible_ca.effective_to')->orWhere('visible_ca.effective_to', '>', $day);
                    });
            })
            ->join('campuses as visible_campus', 'visible_campus.id', '=', 'visible_ca.campus_id')
            ->join('organizations as visible_org', 'visible_org.id', '=', 'visible_campus.organization_id')
            ->whereIn('branches.id', $branchIds)
            ->where('branches.lifecycle_state', 'active')
            ->where('visible_campus.lifecycle_state', 'active')
            ->where('visible_org.lifecycle_state', 'active')
            ->pluck('branches.id')
            ->map(static fn ($value): string => trim((string) $value))
            ->filter(static fn (string $value): bool => $value !== '')
            ->unique()
            ->values()
            ->all();
    }
}
