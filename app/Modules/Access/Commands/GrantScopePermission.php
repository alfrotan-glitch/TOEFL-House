<?php

declare(strict_types=1);

namespace App\Modules\Access\Commands;

use App\Modules\Access\Domain\AccessLifecycle;
use App\Modules\Access\Models\OrgWideGrantRequest;
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
 * emergency grants are dated, limited, flagged for mandatory review, and
 * audited. Grants are never deleted: they expire or are revoked.
 *
 * Organization-wide grants are STAGED (000116): a grantor session requests,
 * two DISTINCT approver sessions each sign in their own session, and the
 * grant is executed only from 'approved'. The two signatures are never
 * typed into one request.
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

    /** @return array{grant_id: string, correlation_id: string} */
    public function grant(
        Actor $grantor,
        string $personId,
        string $permission,
        string $scopeType,
        string $scopeId,
        CarbonImmutable $effectiveFrom,
        ?CarbonImmutable $effectiveTo,
        bool $emergency,
        string $idempotencyKey,
    ): array {
        $payload = hash('sha256', implode('|', ['access.grant', $personId, $permission, $scopeType, $scopeId, $effectiveFrom->toDateString(), $effectiveTo?->toDateString() ?? '', $emergency ? '1' : '0', $grantor->actorId]));

        try {
            return $this->idempotency->execute('access.grant', $idempotencyKey, $payload,
                fn (): array => DB::transaction(function () use ($grantor, $personId, $permission, $scopeType, $scopeId, $effectiveFrom, $effectiveTo, $emergency): array {
                    $this->requireNotSelf($grantor, $personId);
                    if ($scopeType === 'organization') {
                        throw BusinessRejection::forCode('access.grant_org_wide_requires_request', 'organization-wide grants proceed only through the staged approval chain');
                    }

                    $targetScope = $this->scopeOfType($scopeType, $scopeId);
                    $outcome = $this->access->decide($grantor, self::CAPABILITY, $targetScope);
                    if (! $outcome->allowed) {
                        throw AuthorizationDenied::forCode('access.grant_denied', $outcome->reason);
                    }
                    $this->requireEmergencyTerms($effectiveFrom, $effectiveTo, $emergency);

                    $grant = $this->recordGrant($personId, $permission, $scopeType, $scopeId, $effectiveFrom, $effectiveTo, $emergency, $grantor->actorId);
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

    /** @return array{request_id: string, correlation_id: string} */
    public function request(
        Actor $grantor,
        string $personId,
        string $permission,
        string $organizationId,
        CarbonImmutable $effectiveFrom,
        ?CarbonImmutable $effectiveTo,
        bool $emergency,
        string $idempotencyKey,
    ): array {
        $payload = hash('sha256', implode('|', ['access.org_wide_grant.request', $personId, $permission, $organizationId, $effectiveFrom->toDateString(), $effectiveTo?->toDateString() ?? '', $emergency ? '1' : '0', $grantor->actorId]));

        try {
            return $this->idempotency->execute('access.org_wide_grant.request', $idempotencyKey, $payload,
                fn (): array => DB::transaction(function () use ($grantor, $personId, $permission, $organizationId, $effectiveFrom, $effectiveTo, $emergency): array {
                    $this->requireNotSelf($grantor, $personId);

                    $outcome = $this->access->decide($grantor, self::CAPABILITY, new StructureScope($organizationId));
                    if (! $outcome->allowed) {
                        throw AuthorizationDenied::forCode('access.grant_denied', $outcome->reason);
                    }
                    $this->requireEmergencyTerms($effectiveFrom, $effectiveTo, $emergency);

                    $request = OrgWideGrantRequest::query()->create([
                        'id' => RandomIdentifier::new(),
                        'person_id' => $personId,
                        'permission' => $permission,
                        'organization_id' => $organizationId,
                        'is_emergency' => $emergency,
                        'effective_from' => $effectiveFrom->startOfDay()->toDateString(),
                        'effective_to' => $effectiveTo?->startOfDay()->toDateString(),
                        'lifecycle_state' => 'requested',
                        'requested_by' => $grantor->actorId,
                    ]);
                    $event = $this->audit->record($grantor->actorId, 'access.org_wide_grant.request', 'org_wide_grant_request', $request->id, null, [
                        'person_id' => $personId,
                        'permission' => $permission,
                        'organization_id' => $organizationId,
                        'is_emergency' => $emergency,
                    ]);

                    return ['request_id' => $request->id, 'correlation_id' => $event->correlation_id];
                }),
            );
        } catch (AuthorizationDenied $denial) {
            $this->attemptedOperation->deniedByActor($denial, $grantor, 'access.org_wide_grant.request', 'org_wide_grant_request', $personId);
        }
    }

    /** @return array{request_id: string, lifecycle_state: string, correlation_id: string} */
    public function approve(Actor $approver, OrgWideGrantRequest $request, string $idempotencyKey): array
    {
        $payload = hash('sha256', implode('|', ['access.org_wide_grant.approve', $request->id, $approver->actorId]));

        try {
            return $this->idempotency->execute('access.org_wide_grant.approve', $idempotencyKey, $payload,
                fn (): array => DB::transaction(function () use ($approver, $request): array {
                    $scope = new StructureScope($request->organization_id);
                    $outcome = $this->access->decide($approver, self::CAPABILITY_ORG_WIDE_APPROVE, $scope);
                    if (! $outcome->allowed) {
                        throw AuthorizationDenied::forCode('access.org_wide_approver_denied', $outcome->reason);
                    }

                    /** @var OrgWideGrantRequest $locked */
                    $locked = OrgWideGrantRequest::query()->whereKey($request->id)->lockForUpdate()->firstOrFail();
                    if ($locked->lifecycle_state !== 'requested') {
                        throw BusinessRejection::forCode('access.org_wide_grant_state', sprintf('the request is already %s; approvals only count while it is requested', $locked->lifecycle_state));
                    }

                    // Separation of duties: every other staged workflow
                    // (refunds, admissions, corrections) requires the
                    // requester/initiator to differ from anyone who signs.
                    // The requestor who created an org-wide grant request may
                    // never also approve it — otherwise one session could
                    // request AND self-sign the first approval slot.
                    if (trim((string) $locked->requested_by) === $approver->actorId) {
                        throw AuthorizationDenied::forCode('access.org_wide_single_actor', 'the grant requestor may not also approve the organization-wide grant');
                    }

                    if ($locked->approver_one_id === null) {
                        $locked->forceFill(['approver_one_id' => $approver->actorId]);
                        $state = 'requested';
                    } else {
                        if (trim((string) $locked->approver_one_id) === $approver->actorId) {
                            throw AuthorizationDenied::forCode('access.org_wide_single_actor', 'organization-wide grants require two distinct approvers');
                        }
                        $locked->forceFill(['approver_two_id' => $approver->actorId, 'lifecycle_state' => 'approved']);
                        $state = 'approved';
                    }
                    $locked->save();

                    $event = $this->audit->record($approver->actorId, 'access.org_wide_grant.approve', 'org_wide_grant_request', $locked->id, null, [
                        'person_id' => $locked->person_id,
                        'permission' => $locked->permission,
                        'lifecycle_state' => $state,
                        'approver_one_id' => $locked->approver_one_id,
                        'approver_two_id' => $locked->approver_two_id,
                    ]);

                    return ['request_id' => $locked->id, 'lifecycle_state' => $state, 'correlation_id' => $event->correlation_id];
                }),
            );
        } catch (AuthorizationDenied $denial) {
            $this->attemptedOperation->deniedByActor($denial, $approver, 'access.org_wide_grant.approve', 'org_wide_grant_request', $request->id);
        }
    }

    /** @return array{grant_id: string, correlation_id: string} */
    public function execute(Actor $executor, OrgWideGrantRequest $request, string $idempotencyKey): array
    {
        $payload = hash('sha256', implode('|', ['access.grant', $request->id, $executor->actorId]));

        try {
            return $this->idempotency->execute('access.grant', $idempotencyKey, $payload,
                fn (): array => DB::transaction(function () use ($executor, $request): array {
                    /** @var OrgWideGrantRequest $locked */
                    $locked = OrgWideGrantRequest::query()->whereKey($request->id)->lockForUpdate()->firstOrFail();

                    $outcome = $this->access->decide($executor, self::CAPABILITY, new StructureScope($locked->organization_id));
                    if (! $outcome->allowed) {
                        throw AuthorizationDenied::forCode('access.grant_denied', $outcome->reason);
                    }
                    if ($locked->lifecycle_state !== 'approved') {
                        throw BusinessRejection::forCode('access.org_wide_grant_state', sprintf('the request must be approved before execution; it is %s', $locked->lifecycle_state));
                    }

                    $grant = $this->recordGrant(
                        $locked->person_id,
                        $locked->permission,
                        'organization',
                        $locked->organization_id,
                        new CarbonImmutable((string) $locked->effective_from),
                        $locked->effective_to !== null ? new CarbonImmutable((string) $locked->effective_to) : null,
                        $locked->is_emergency,
                        $executor->actorId,
                    );
                    $locked->forceFill([
                        'lifecycle_state' => 'granted',
                        'granted_by' => $executor->actorId,
                        'grant_id' => $grant->id,
                    ]);
                    $locked->save();

                    $event = $this->audit->record($executor->actorId, 'access.grant', 'scope_grant', $grant->id, null, [
                        'person_id' => $locked->person_id,
                        'permission' => $locked->permission,
                        'scope' => 'organization:'.$locked->organization_id,
                        'effective_from' => $grant->effective_from,
                        'effective_to' => $grant->effective_to,
                        'is_emergency' => $locked->is_emergency,
                        'review_required' => $locked->is_emergency,
                        'request_id' => $locked->id,
                    ]);

                    return ['grant_id' => $grant->id, 'correlation_id' => $event->correlation_id];
                }),
            );
        } catch (AuthorizationDenied $denial) {
            $this->attemptedOperation->deniedByActor($denial, $executor, 'access.grant', 'org_wide_grant_request', $request->id);
        }
    }

    private function requireNotSelf(Actor $grantor, string $personId): void
    {
        if ($personId === $grantor->actorId) {
            throw AuthorizationDenied::forCode('access.self_grant_forbidden', 'a person may not grant authority to themselves');
        }
    }

    private function requireEmergencyTerms(CarbonImmutable $effectiveFrom, ?CarbonImmutable $effectiveTo, bool $emergency): void
    {
        if (! $emergency) {
            return;
        }
        if ($effectiveTo === null) {
            throw BusinessRejection::forCode('access.emergency_requires_expiry', 'emergency authority must carry an expiry date');
        }
        if (abs($effectiveTo->startOfDay()->diffInDays($effectiveFrom->startOfDay())) > self::EMERGENCY_MAXIMUM_DAYS) {
            throw BusinessRejection::forCode('access.emergency_exceeds_limit', sprintf('emergency authority is limited to %d days', self::EMERGENCY_MAXIMUM_DAYS));
        }
    }

    private function recordGrant(
        string $personId,
        string $permission,
        string $scopeType,
        string $scopeId,
        CarbonImmutable $effectiveFrom,
        ?CarbonImmutable $effectiveTo,
        bool $emergency,
        string $grantedBy,
    ): ScopeGrant {
        return ScopeGrant::query()->create([
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
            'granted_by' => $grantedBy,
        ]);
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
