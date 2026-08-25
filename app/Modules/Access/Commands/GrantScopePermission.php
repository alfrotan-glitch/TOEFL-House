<?php

declare(strict_types=1);

namespace App\Modules\Access\Commands;

use App\Modules\Access\Domain\AccessLifecycle;
use App\Modules\Access\Models\ScopeGrant;
use App\Modules\Audit\AttemptedOperation;
use App\Modules\Audit\AuditRecorder;
use App\Modules\Organization\Models\Campus;
use App\Support\Authorization\AccessDecision;
use App\Support\Authorization\Actor;
use App\Support\Authorization\StructureScope;
use App\Support\Errors\AuthorizationDenied;
use App\Support\Errors\BusinessRejection;
use App\Support\Idempotency\IdempotentExecution;
use App\Support\Identifiers\RandomIdentifier;
use Carbon\CarbonImmutable;
use Illuminate\Support\Facades\DB;

/**
 * Grants a named-scope permission to a person. Self-grants are forbidden;
 * organization-wide grants require two distinct eligible approvers; and
 * emergency grants are dated, limited, flagged for mandatory review, and
 * audited. Grants are never deleted: they expire or are revoked.
 */
final class GrantScopePermission
{
    public const CAPABILITY = 'access.grant';

    public const CAPABILITY_ORG_WIDE_APPROVE = 'access.approve_org_wide';

    public const EMERGENCY_MAXIMUM_DAYS = 30;

    public function __construct(
        private readonly AccessDecision $access,
        private readonly IdempotentExecution $idempotency,
        private readonly AuditRecorder $audit,
        private readonly AttemptedOperation $attemptedOperation,
    ) {}

    /**
     * @param  list<Actor>  $organizationWideApprovers
     * @return array{grant_id: string, correlation_id: string}
     */
    public function grant(
        Actor $grantor,
        string $personId,
        string $permission,
        string $scopeType,
        string $scopeId,
        CarbonImmutable $effectiveFrom,
        ?CarbonImmutable $effectiveTo,
        bool $emergency,
        array $organizationWideApprovers,
        string $idempotencyKey,
    ): array {
        $payload = hash('sha256', implode('|', ['access.grant', $personId, $permission, $scopeType, $scopeId, $effectiveFrom->toDateString(), $effectiveTo?->toDateString() ?? '', $emergency ? '1' : '0', $grantor->actorId]));

        try {
            return $this->idempotency->execute('access.grant', $idempotencyKey, $payload,
                fn (): array => DB::transaction(function () use ($grantor, $personId, $permission, $scopeType, $scopeId, $effectiveFrom, $effectiveTo, $emergency, $organizationWideApprovers): array {
                    if ($personId === $grantor->actorId) {
                        throw AuthorizationDenied::forCode('access.self_grant_forbidden', 'a person may not grant authority to themselves');
                    }

                    $targetScope = $scopeType === 'organization'
                        ? new StructureScope($scopeId)
                        : $this->scopeOfType($scopeType, $scopeId);
                    $outcome = $this->access->decide($grantor, self::CAPABILITY, $targetScope);
                    if (! $outcome->allowed) {
                        throw AuthorizationDenied::forCode('access.grant_denied', $outcome->reason);
                    }

                    if ($scopeType === 'organization') {
                        $this->requireTwoDistinctApprovers($organizationWideApprovers, $scopeId);
                    }
                    if ($emergency) {
                        if ($effectiveTo === null) {
                            throw BusinessRejection::forCode('access.emergency_requires_expiry', 'emergency authority must carry an expiry date');
                        }
                        if (abs($effectiveTo->startOfDay()->diffInDays($effectiveFrom->startOfDay())) > self::EMERGENCY_MAXIMUM_DAYS) {
                            throw BusinessRejection::forCode('access.emergency_exceeds_limit', sprintf('emergency authority is limited to %d days', self::EMERGENCY_MAXIMUM_DAYS));
                        }
                    }

                    $grant = ScopeGrant::query()->create([
                        'id' => RandomIdentifier::new(),
                        'person_id' => $personId,
                        'permission' => $permission,
                        'scope_type' => $scopeType,
                        'scope_id' => $scopeId,
                        'lifecycle_state' => AccessLifecycle::STATE_ACTIVE,
                        'effective_from' => $effectiveFrom->startOfDay()->toDateString(),
                        'effective_to' => $effectiveTo?->startOfDay()->toDateString(),
                        'is_emergency' => $emergency,
                        'review_required' => $emergency,
                        'granted_by' => $grantor->actorId,
                    ]);

                    $event = $this->audit->record($grantor->actorId, 'access.grant', 'scope_grant', $grant->id, null, [
                        'person_id' => $personId,
                        'permission' => $permission,
                        'scope' => $scopeType.':'.$scopeId,
                        'effective_from' => $grant->effective_from,
                        'effective_to' => $grant->effective_to,
                        'is_emergency' => $emergency,
                        'review_required' => $emergency,
                    ]);

                    return ['grant_id' => $grant->id, 'correlation_id' => $event->correlation_id];
                }),
            );
        } catch (AuthorizationDenied $denial) {
            $this->attemptedOperation->deniedByActor($denial, $grantor, 'access.grant', 'scope_grant', $personId);
        }
    }

    /**
     * @param  list<Actor>  $approvers
     */
    private function requireTwoDistinctApprovers(array $approvers, string $organizationId): void
    {
        if (count($approvers) < 2) {
            throw AuthorizationDenied::forCode('access.org_wide_owner_count', 'two distinct owner approvals required for organization-wide grants');
        }

        $scope = new StructureScope($organizationId);
        $seen = [];
        foreach ($approvers as $approver) {
            if (in_array($approver->actorId, $seen, true)) {
                throw AuthorizationDenied::forCode('access.org_wide_single_actor', 'organization-wide grants require two distinct approvers');
            }
            $seen[] = $approver->actorId;
            $outcome = $this->access->decide($approver, self::CAPABILITY_ORG_WIDE_APPROVE, $scope);
            if (! $outcome->allowed) {
                throw AuthorizationDenied::forCode('access.org_wide_approver_denied', $outcome->reason);
            }
        }
    }

    private function scopeOfType(string $scopeType, string $scopeId): StructureScope
    {
        return match ($scopeType) {
            'campus' => new StructureScope($this->campusOrganization($scopeId), $scopeId),
            'branch' => new StructureScope('', null, $scopeId),
            'department' => new StructureScope('', null, null, $scopeId),
            default => throw BusinessRejection::forCode('access.scope_type_unknown', sprintf('unknown scope type %s', $scopeType)),
        };
    }

    private function campusOrganization(string $campusId): string
    {
        $organizationId = Campus::query()->whereKey($campusId)->value('organization_id');
        if ($organizationId === null) {
            throw BusinessRejection::forCode('access.scope_unavailable', 'campus scope does not resolve to an active structure');
        }

        return (string) $organizationId;
    }
}
