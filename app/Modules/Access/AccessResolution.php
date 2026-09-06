<?php

declare(strict_types=1);

namespace App\Modules\Access;

use App\Modules\Access\Models\AccessPolicy;
use App\Modules\Access\Models\Delegation;
use App\Modules\Access\Models\Position;
use App\Modules\Access\Models\PositionAssignment;
use App\Modules\Access\Models\ScopeGrant;
use App\Support\Authorization\AccessDecision;
use App\Support\Authorization\Actor;
use App\Support\Authorization\Decision;
use App\Support\Authorization\StructureScope;
use Carbon\CarbonImmutable;

/**
 * Canonical server authorization: resolves Position + Assignment + Role +
 * Permission + Scope + Delegation at the effective time. Default deny;
 * assignments, grants, policies, and delegations expire by date without any
 * rewrite. The delegate never receives authority beyond the delegator's own,
 * and a delegation is resolved one level deep only.
 */
final class AccessResolution implements AccessDecision
{
    public function __construct(private readonly ?CarbonImmutable $effectiveTime = null) {}

    public function decide(Actor $actor, string $capability, ?StructureScope $scope): Decision
    {
        if ($actor->actorId === '') {
            return Decision::deny('actor identity missing');
        }

        $today = ($this->effectiveTime ?? CarbonImmutable::now())->startOfDay()->toDateString();

        foreach ($this->authorityScopeKeys($actor->actorId, $capability, $today) as $authorityScopeKey) {
            if ($scope === null) {
                return Decision::allow();
            }
            if (in_array($authorityScopeKey, $scope->coveringScopeKeys(), true)) {
                return Decision::allow();
            }
        }

        return Decision::deny(sprintf('no active authority grants %s in scope', $capability));
    }

    /**
     * Scope keys of every effective authority carrying the capability:
     * role-derived through active position assignments, direct named-scope
     * grants, and delegations bounded by the delegator's own authority.
     *
     * @return list<string>
     */
    private function authorityScopeKeys(string $personId, string $capability, string $today): array
    {
        return array_values(array_unique(array_merge(
            $this->roleDerivedScopeKeys($personId, $capability, $today),
            $this->grantedScopeKeys($personId, $capability, $today),
            $this->delegatedScopeKeys($personId, $capability, $today),
        ), SORT_STRING));
    }

    /** @return list<string> */
    private function roleDerivedScopeKeys(string $personId, string $capability, string $today): array
    {
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
        return ScopeGrant::query()
            ->where('person_id', $personId)
            ->where('permission', $capability)
            ->where('lifecycle_state', 'active')
            ->where('effective_from', '<=', $today)
            ->where(fn ($query) => $query->whereNull('effective_to')->orWhere('effective_to', '>', $today))
            ->get()
            ->map(static fn (ScopeGrant $grant): string => $grant->scope_type.':'.$grant->scope_id)
            ->all();
    }

    /** @return list<string> */
    private function delegatedScopeKeys(string $delegateId, string $capability, string $today): array
    {
        $delegations = Delegation::query()
            ->where('delegate_person_id', $delegateId)
            ->where('lifecycle_state', 'active')
            ->where('effective_from', '<=', $today)
            ->where('effective_to', '>', $today)
            ->get();

        $keys = [];
        foreach ($delegations as $delegation) {
            if ($delegation->permission !== null && $delegation->permission !== $capability) {
                continue;
            }

            $delegatorKeys = array_merge(
                $this->roleDerivedScopeKeys($delegation->delegator_person_id, $capability, $today),
                $this->grantedScopeKeys($delegation->delegator_person_id, $capability, $today),
            );
            foreach ($delegatorKeys as $delegatorKey) {
                if ($this->delegationCoversScope($delegation, $delegatorKey)) {
                    $keys[] = $delegatorKey;
                }
            }
        }

        return $keys;
    }

    /**
     * A scoped delegation narrows the delegator's authority to exactly the
     * delegated scope key; anything wider fails closed until a broader
     * delegation exists.
     */
    private function delegationCoversScope(Delegation $delegation, string $scopeKey): bool
    {
        if ($delegation->scope_type === null) {
            return true;
        }

        return $scopeKey === $delegation->scope_type.':'.$delegation->scope_id;
    }

    /**
     * Active policy grants of one binding as of the day: identifiers when
     * the policy binds a role, permission strings when it grants one.
     *
     * @return list<string>
     */
    private function activePolicyGrants(string $bindingType, string $bindingId, string $grantsType, string $today): array
    {
        return AccessPolicy::query()
            ->where('binding_type', $bindingType)
            ->where('binding_id', $bindingId)
            ->where('grants_type', $grantsType)
            ->where('effective_from', '<=', $today)
            ->where(fn ($query) => $query->whereNull('effective_to')->orWhere('effective_to', '>', $today))
            ->pluck($grantsType === AccessPolicy::GRANTS_ROLE ? 'grants_id' : 'permission')
            ->map(static fn ($value): string => (string) $value)
            ->all();
    }

    private function positionOrganization(string $positionId): ?string
    {
        $organizationId = Position::query()->whereKey($positionId)->value('organization_id');

        return $organizationId !== null ? (string) $organizationId : null;
    }
}
