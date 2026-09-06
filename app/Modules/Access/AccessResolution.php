<?php

declare(strict_types=1);

namespace App\Modules\Access;

use App\Modules\Access\Models\AccessPolicy;
use App\Modules\Access\Models\Delegation;
use App\Modules\Access\Models\Position;
use App\Modules\Access\Models\PositionAssignment;
use App\Modules\Access\Models\ScopeGrant;
use App\Modules\Hr\Domain\EmploymentLifecycle;
use App\Modules\Hr\Models\Employment;
use App\Modules\Organization\Models\Branch;
use App\Modules\Organization\Models\Campus;
use App\Modules\Organization\Models\CampusAssignment;
use App\Modules\Organization\Models\Department;
use App\Modules\Organization\Models\Organization;
use App\Support\Authorization\AccessDecision;
use App\Support\Authorization\Actor;
use App\Support\Authorization\Decision;
use App\Support\Authorization\StructureScope;
use Carbon\CarbonImmutable;

/**
 * Canonical server authorization: resolves Position + Assignment + Role +
 * Permission + Scope + Delegation at the effective time. Default deny;
 * assignments, grants, policies, and delegations expire by date without any
 * rewrite. Employment eligibility and operational structure lifecycle are
 * predicates here, not a second authorization model in HR or Organization.
 */
final class AccessResolution implements AccessDecision
{
    public function __construct(private readonly ?CarbonImmutable $effectiveTime = null) {}

    public function decide(Actor $actor, string $capability, ?StructureScope $scope): Decision
    {
        if ($actor->actorId === '') {
            return Decision::deny('actor identity missing');
        }
        if ($scope?->isUnknown()) {
            return Decision::deny('target provenance is unknown');
        }

        $today = ($this->effectiveTime ?? CarbonImmutable::now())->startOfDay()->toDateString();
        if ($scope !== null && ! $scope->allowInactiveLifecycle && ! $this->operationalScopeIsActive($scope, $today)) {
            return Decision::deny('target organization structure is not operationally active');
        }

        foreach ($this->authorityScopeKeys($actor->actorId, $capability, $today) as $authorityScopeKey) {
            // Null is not a wildcard. It means the operation is explicitly
            // organization-wide/branchless, so only an organization-rooted
            // authority may satisfy it. Branch/campus grants must be checked
            // against a concrete target scope by the command.
            if ($scope === null && str_starts_with($authorityScopeKey, 'organization:')) {
                $organizationId = substr($authorityScopeKey, strlen('organization:'));
                if ($organizationId !== '' && Organization::query()
                    ->whereKey($organizationId)
                    ->where('lifecycle_state', 'active')
                    ->exists()) {
                    return Decision::allow();
                }
            }
            if ($scope !== null && in_array($authorityScopeKey, $scope->coveringScopeKeys(), true)) {
                return Decision::allow();
            }
        }

        return Decision::deny($scope === null
            ? 'an organization-wide authority grant is required'
            : sprintf('no active authority grants %s in scope', $capability));
    }

    /**
     * A person without an HR relationship may be an explicitly appointed
     * non-employee owner/auditor. Once HR owns an employment relationship,
     * however, only active employment is eligible for any human authority.
     * This is an eligibility fact consumed by Access, not HR authorization.
     */
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

    /** @return list<string> */
    private function authorityScopeKeys(string $personId, string $capability, string $today): array
    {
        if (! $this->employmentEligible($personId)) {
            return [];
        }

        return array_values(array_unique(array_merge(
            $this->roleDerivedScopeKeys($personId, $capability, $today),
            $this->grantedScopeKeys($personId, $capability, $today),
            $this->delegatedScopeKeys($personId, $capability, $today),
        ), SORT_STRING));
    }

    /** @return list<string> */
    private function roleDerivedScopeKeys(string $personId, string $capability, string $today): array
    {
        if (! $this->employmentEligible($personId)) {
            return [];
        }

        $assignments = PositionAssignment::query()
            ->where('person_id', $personId)
            ->where('lifecycle_state', 'active')
            ->where('effective_from', '<=', $today)
            ->where(fn ($query) => $query->whereNull('effective_to')->orWhere('effective_to', '>', $today))
            ->get();

        $keys = [];
        foreach ($assignments as $assignment) {
            $roleIds = $this->activePolicyGrants('position', $assignment->position_id, AccessPolicy::GRANTS_ROLE, $today);
            foreach ($roleIds as $roleId) {
                $permissions = $this->activePolicyGrants('role', $roleId, AccessPolicy::GRANTS_PERMISSION, $today);
                foreach ($permissions as $permission) {
                    if ($permission === $capability) {
                        $organizationId = $this->positionOrganization($assignment->position_id);
                        if ($organizationId !== null) {
                            $keys[] = 'organization:'.$organizationId;
                        }
                    }
                }
            }
        }

        return $keys;
    }

    /** @return list<string> */
    private function grantedScopeKeys(string $personId, string $capability, string $today): array
    {
        if (! $this->employmentEligible($personId)) {
            return [];
        }

        return array_values(ScopeGrant::query()
            ->where('person_id', $personId)
            ->where('permission', $capability)
            ->where('lifecycle_state', 'active')
            ->where('effective_from', '<=', $today)
            ->where(fn ($query) => $query->whereNull('effective_to')->orWhere('effective_to', '>', $today))
            ->get()
            ->map(static fn (ScopeGrant $grant): string => $grant->scope_type.':'.$grant->scope_id)
            ->values()
            ->all());
    }

    /** @return list<string> */
    private function delegatedScopeKeys(string $delegateId, string $capability, string $today): array
    {
        if (! $this->employmentEligible($delegateId)) {
            return [];
        }

        $delegations = Delegation::query()
            ->where('delegate_person_id', $delegateId)
            ->where('lifecycle_state', 'active')
            ->where('effective_from', '<=', $today)
            ->where('effective_to', '>', $today)
            ->get();

        $keys = [];
        foreach ($delegations as $delegation) {
            if ($delegation->permission === null || trim((string) $delegation->permission) === '' || $delegation->permission !== $capability) {
                continue;
            }
            if (! $this->employmentEligible((string) $delegation->delegator_person_id)) {
                continue;
            }

            $delegatorKeys = array_merge(
                $this->roleDerivedScopeKeys($delegation->delegator_person_id, $capability, $today),
                $this->grantedScopeKeys($delegation->delegator_person_id, $capability, $today),
            );
            $delegatedKey = $this->delegationPrimaryScopeKey($delegation, $today);
            if ($delegatedKey === null) {
                continue;
            }
            foreach ($delegatorKeys as $delegatorKey) {
                if ($this->delegationCoversScope($delegation, $delegatorKey, $today)) {
                    // The delegate receives the named scope, not every
                    // ancestor scope that happened to authorize it.
                    $keys[] = $delegatedKey;
                    break;
                }
            }
        }

        return $keys;
    }

    private function delegationPrimaryScopeKey(Delegation $delegation, string $day): ?string
    {
        $scopeType = trim((string) $delegation->scope_type);
        $scopeId = trim((string) $delegation->scope_id);
        if ($scopeId === '' || ! in_array($scopeType, ['organization', 'campus', 'branch', 'department'], true)) {
            return null;
        }

        return $this->delegationScopeKeys($delegation, $day) === [] ? null : $scopeType.':'.$scopeId;
    }

    private function delegationCoversScope(Delegation $delegation, string $scopeKey, string $day): bool
    {
        // A legacy/null scope is not a wildcard. New delegations require an
        // explicit structure scope, and old unscoped rows remain unusable
        // until reconciled. Ancestor authority may be delegated to a narrower
        // descendant scope, but only after the target scope is resolved from
        // the same effective topology used by the decision point.
        if ($delegation->scope_type === null || trim((string) $delegation->scope_id) === '') {
            return false;
        }

        foreach ($this->delegationScopeKeys($delegation, $day) as $coveredKey) {
            if ($scopeKey === $coveredKey) {
                return true;
            }
        }

        return false;
    }

    /** @return list<string> */
    private function delegationScopeKeys(Delegation $delegation, string $day): array
    {
        $scopeType = trim((string) $delegation->scope_type);
        $scopeId = trim((string) $delegation->scope_id);
        if ($scopeId === '') {
            return [];
        }

        if ($scopeType === 'organization') {
            return Organization::query()->whereKey($scopeId)->where('lifecycle_state', 'active')->exists()
                ? ['organization:'.$scopeId]
                : [];
        }
        if ($scopeType === 'campus') {
            /** @var Campus|null $campus */
            $campus = Campus::query()->whereKey($scopeId)->first();
            if ($campus === null || $campus->lifecycle_state !== 'active') {
                return [];
            }
            $organization = Organization::query()->whereKey($campus->organization_id)->where('lifecycle_state', 'active')->exists();

            return $organization ? ['campus:'.$campus->id, 'organization:'.$campus->organization_id] : [];
        }
        if ($scopeType === 'branch') {
            /** @var Branch|null $branch */
            $branch = Branch::query()->whereKey($scopeId)->first();
            if ($branch === null || $branch->lifecycle_state !== 'active') {
                return [];
            }
            /** @var CampusAssignment|null $assignment */
            $assignment = CampusAssignment::query()
                ->where('branch_id', $branch->id)
                ->where('effective_from', '<=', $day)
                ->where(fn ($query) => $query->whereNull('effective_to')->orWhere('effective_to', '>', $day))
                ->orderByDesc('effective_from')
                ->first();
            if ($assignment === null) {
                return [];
            }
            /** @var Campus|null $campus */
            $campus = Campus::query()->whereKey($assignment->campus_id)->where('lifecycle_state', 'active')->first();
            if ($campus === null) {
                return [];
            }
            $organization = Organization::query()->whereKey($campus->organization_id)->where('lifecycle_state', 'active')->exists();

            return $organization
                ? ['branch:'.$branch->id, 'campus:'.$campus->id, 'organization:'.$campus->organization_id]
                : [];
        }
        if ($scopeType === 'department') {
            /** @var Department|null $department */
            $department = Department::query()->whereKey($scopeId)->first();
            if ($department === null || $department->lifecycle_state !== 'active') {
                return [];
            }
            $parent = $this->departmentParentScope($department, $day);
            if ($parent === null || ! $this->operationalScopeIsActive($parent, $day)) {
                return [];
            }

            return array_values(array_unique(array_merge(
                ['department:'.$department->id],
                $parent->coveringScopeKeys(),
            ), SORT_STRING));
        }

        return [];
    }

    private function departmentParentScope(Department $department, string $day): ?StructureScope
    {
        $scopeType = trim((string) $department->scope_type);
        $scopeId = trim((string) $department->scope_id);
        if ($scopeId === '') {
            return null;
        }
        if ($scopeType === 'organization') {
            return StructureScope::organization($scopeId);
        }
        if ($scopeType === 'campus') {
            /** @var Campus|null $campus */
            $campus = Campus::query()->whereKey($scopeId)->first();
            if ($campus === null) {
                return null;
            }

            return new StructureScope($campus->organization_id, $campus->id);
        }
        if ($scopeType !== 'branch') {
            return null;
        }

        /** @var Branch|null $branch */
        $branch = Branch::query()->whereKey($scopeId)->first();
        if ($branch === null) {
            return null;
        }
        /** @var CampusAssignment|null $assignment */
        $assignment = CampusAssignment::query()
            ->where('branch_id', $branch->id)
            ->where('effective_from', '<=', $day)
            ->where(fn ($query) => $query->whereNull('effective_to')->orWhere('effective_to', '>', $day))
            ->orderByDesc('effective_from')
            ->first();
        if ($assignment === null) {
            return null;
        }
        /** @var Campus|null $campus */
        $campus = Campus::query()->whereKey($assignment->campus_id)->first();
        if ($campus === null) {
            return null;
        }

        return new StructureScope($campus->organization_id, $campus->id, $branch->id);
    }

    /** @return list<string> */
    private function activePolicyGrants(string $bindingType, string $bindingId, string $grantsType, string $today): array
    {
        return array_values(AccessPolicy::query()
            ->where('binding_type', $bindingType)
            ->where('binding_id', $bindingId)
            ->where('grants_type', $grantsType)
            ->where('effective_from', '<=', $today)
            ->where(fn ($query) => $query->whereNull('effective_to')->orWhere('effective_to', '>', $today))
            ->pluck($grantsType === AccessPolicy::GRANTS_ROLE ? 'grants_id' : 'permission')
            ->map(static fn ($value): string => (string) $value)
            ->values()
            ->all());
    }

    private function positionOrganization(string $positionId): ?string
    {
        $organizationId = Position::query()->whereKey($positionId)->value('organization_id');

        return $organizationId !== null ? (string) $organizationId : null;
    }

    /**
     * Scoped operational authority is valid only through active structure.
     * A branch's open campus assignment is part of its provenance; a detached
     * branch is therefore not covered by an organization grant.
     */
    private function operationalScopeIsActive(StructureScope $scope, string $day): bool
    {
        if ($scope->isUnknown()) {
            return false;
        }
        if ($scope->departmentId !== null) {
            /** @var Department|null $department */
            $department = Department::query()->whereKey($scope->departmentId)->first();
            $parent = $department === null ? null : $this->departmentParentScope($department, $day);
            if ($department === null || $department->lifecycle_state !== 'active' || $parent === null
                || $parent->organizationId !== $scope->organizationId
                || $parent->campusId !== $scope->campusId
                || $parent->branchId !== $scope->branchId) {
                return false;
            }
        }
        if ($scope->branchId !== null) {
            /** @var Branch|null $branch */
            $branch = Branch::query()->whereKey($scope->branchId)->lockForUpdate()->first();
            if ($branch === null || $branch->lifecycle_state !== 'active') {
                return false;
            }
            /** @var CampusAssignment|null $assignment */
            $assignment = CampusAssignment::query()
                ->where('branch_id', $branch->id)
                ->where('effective_from', '<=', $day)
                ->where(fn ($query) => $query->whereNull('effective_to')->orWhere('effective_to', '>', $day))
                ->orderByDesc('effective_from')
                ->first();
            if ($assignment === null || ($scope->campusId !== null && $assignment->campus_id !== $scope->campusId)) {
                return false;
            }
            /** @var Campus|null $campus */
            $campus = Campus::query()->whereKey($assignment->campus_id)->first();
            if ($campus === null || $campus->lifecycle_state !== 'active') {
                return false;
            }
            /** @var Organization|null $organization */
            $organization = Organization::query()->whereKey($campus->organization_id)->first();

            return $organization !== null && $organization->lifecycle_state === 'active' && $organization->id === $scope->organizationId;
        }
        if ($scope->campusId !== null) {
            /** @var Campus|null $campus */
            $campus = Campus::query()->whereKey($scope->campusId)->first();
            if ($campus === null || $campus->lifecycle_state !== 'active' || $campus->organization_id !== $scope->organizationId) {
                return false;
            }
            $organization = Organization::query()->whereKey($campus->organization_id)->first();

            return $organization !== null && $organization->lifecycle_state === 'active';
        }
        if ($scope->organizationId === '') {
            return false;
        }

        return Organization::query()->whereKey($scope->organizationId)->where('lifecycle_state', 'active')->exists();
    }
}
