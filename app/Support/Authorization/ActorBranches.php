<?php

declare(strict_types=1);

namespace App\Support\Authorization;

use App\Modules\Access\Domain\AccessLifecycle;
use App\Modules\Access\Models\Delegation;
use App\Modules\Access\Models\Position;
use App\Modules\Access\Models\PositionAssignment;
use App\Modules\Access\Models\ScopeGrant;
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
        if (trim($actor->actorId) === '') {
            return [];
        }
        $today = ($this->effectiveTime ?? CarbonImmutable::now())->startOfDay()->toDateString();
        $branches = [];
        foreach ($this->activeGrantScopes($actor->actorId, $today) as [$scopeType, $scopeId]) {
            foreach ($this->branchesForScope($scopeType, $scopeId) as $branchId) {
                $branches[] = $branchId;
            }
        }
        foreach ($this->roleOrganizationIds($actor->actorId, $today) as $organizationId) {
            foreach ($this->branchesForOrganization($organizationId) as $branchId) {
                $branches[] = $branchId;
            }
        }
        $branches = array_values(array_unique($branches, SORT_STRING));
        sort($branches);

        return $branches;
    }

    /**
     * Whether the actor holds any effective authority at all. Null-provenance
     * records are shown only to authorized actors — never to bare sessions.
     */
    public function hasAnyAuthority(Actor $actor): bool
    {
        if (trim($actor->actorId) === '') {
            return false;
        }
        if ($this->visibleBranchIds($actor) !== []) {
            return true;
        }
        $today = ($this->effectiveTime ?? CarbonImmutable::now())->startOfDay()->toDateString();
        if ($this->roleOrganizationIds($actor->actorId, $today) !== []) {
            return true;
        }

        return Delegation::query()
            ->where('delegate_person_id', $actor->actorId)
            ->where('lifecycle_state', AccessLifecycle::STATE_ACTIVE)
            ->where('effective_from', '<=', $today)
            ->where('effective_to', '>', $today)
            ->exists();
    }

    /** Null branch = unknown provenance: visible only to authorized actors. */
    public function allows(Actor $actor, ?string $branchId): bool
    {
        $branchId = trim((string) ($branchId ?? ''));
        if ($branchId === '') {
            return $this->hasAnyAuthority($actor);
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
    private function branchesForScope(string $scopeType, string $scopeId): array
    {
        if ($scopeId === '') {
            return [];
        }

        return match ($scopeType) {
            'branch' => [$scopeId],
            'campus' => $this->branchesForCampus($scopeId),
            'department' => $this->branchesForDepartment($scopeId),
            'organization' => $this->branchesForOrganization($scopeId),
            default => [],
        };
    }

    /** @return list<string> */
    private function branchesForCampus(string $campusId): array
    {
        return CampusAssignment::query()
            ->where('campus_id', $campusId)
            ->whereNull('effective_to')
            ->pluck('branch_id')
            ->map(static fn ($value): string => trim((string) $value))
            ->filter(static fn (string $value): bool => $value !== '')
            ->values()
            ->all();
    }

    /** @return list<string> */
    private function branchesForDepartment(string $departmentId): array
    {
        /** @var Department|null $department */
        $department = Department::query()->find($departmentId);
        if ($department === null) {
            return [];
        }
        $scopeType = trim((string) ($department->scope_type ?? ''));
        $scopeId = trim((string) ($department->scope_id ?? ''));
        if ($scopeType === 'branch' && $scopeId !== '') {
            return [$scopeId];
        }
        if ($scopeType === 'campus' && $scopeId !== '') {
            return $this->branchesForCampus($scopeId);
        }

        return [];
    }

    /** @return list<string> */
    private function branchesForOrganization(string $organizationId): array
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
            ->whereNull('effective_to')
            ->pluck('branch_id')
            ->map(static fn ($value): string => trim((string) $value))
            ->filter(static fn (string $value): bool => $value !== '')
            ->values()
            ->all();
    }
}
