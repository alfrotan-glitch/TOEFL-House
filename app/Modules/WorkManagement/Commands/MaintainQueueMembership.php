<?php

declare(strict_types=1);

namespace App\Modules\WorkManagement\Commands;

use App\Modules\Audit\AttemptedOperation;
use App\Modules\Audit\AuditRecorder;
use App\Modules\Hr\Domain\EmploymentLifecycle;
use App\Modules\Hr\Models\Employment;
use App\Modules\Identity\Models\Person;
use App\Modules\Organization\Models\Branch;
use App\Modules\Organization\Models\Organization;
use App\Modules\WorkManagement\Domain\WorkQueueCatalog;
use App\Modules\WorkManagement\Models\QueueMembership;
use App\Support\Authorization\AccessDecision;
use App\Support\Authorization\Actor;
use App\Support\Authorization\BranchScopedAccess;
use App\Support\Authorization\StructureScope;
use App\Support\Errors\AuthorizationDenied;
use App\Support\Errors\BusinessRejection;
use App\Support\Idempotency\IdempotentExecution;
use App\Support\Identifiers\RandomIdentifier;
use Illuminate\Database\Eloquent\ModelNotFoundException;
use Illuminate\Support\Facades\DB;

/** Owns explicit queue membership, not the source action authorization. */
final class MaintainQueueMembership
{
    public const CAPABILITY = 'workflow.queue.manage';

    private readonly BranchScopedAccess $scoped;

    public function __construct(
        AccessDecision $access,
        private readonly IdempotentExecution $idempotency,
        private readonly AuditRecorder $audit,
        private readonly AttemptedOperation $attemptedOperation,
    ) {
        $this->scoped = new BranchScopedAccess($access);
    }

    /** @return array{membership_id: string, correlation_id: string} */
    public function grant(Actor $manager, string $memberActorId, string $queueKey, ?string $branchId, string $idempotencyKey, ?string $organizationId = null): array
    {
        $memberActorId = trim($memberActorId);
        $queueKey = trim($queueKey);
        $branchId = $branchId === null ? null : trim($branchId);
        $branchId = $branchId === '' ? null : $branchId;
        $organizationId = $organizationId === null ? null : trim($organizationId);
        $organizationId = $organizationId === '' ? null : $organizationId;
        if ($memberActorId === '' || $queueKey === '') {
            throw BusinessRejection::forCode('workflow.queue_membership_invalid', 'queue membership requires an actor and queue key');
        }
        $payload = hash('sha256', implode('|', ['workflow.queue.grant', $memberActorId, $queueKey, $organizationId ?? '', $branchId ?? '', $manager->actorId]));

        try {
            return $this->idempotency->execute('workflow.queue.grant', $idempotencyKey, $payload,
                fn (): array => DB::transaction(function () use ($manager, $memberActorId, $queueKey, $branchId, $organizationId): array {
                    $resolvedOrganizationId = $this->resolveOrganizationId($branchId, $organizationId);
                    $this->authorize($manager, $branchId, $resolvedOrganizationId);
                    WorkQueueCatalog::assertKnown($queueKey);
                    $memberEmployment = Employment::query()
                        ->where('person_id', $memberActorId)
                        ->orderByDesc('created_at')
                        ->orderByDesc('id')
                        ->first();
                    if (! Person::query()->whereKey($memberActorId)->exists()
                        || $memberEmployment === null
                        || $memberEmployment->lifecycle_state !== EmploymentLifecycle::STATE_ACTIVE) {
                        throw BusinessRejection::forCode('workflow.queue_member_ineligible', 'queue membership requires an active employee actor');
                    }
                    $membership = QueueMembership::query()
                        ->where('actor_id', $memberActorId)
                        ->where('queue_key', $queueKey)
                        ->where('organization_id', $resolvedOrganizationId)
                        ->where('branch_id', $branchId)
                        ->first();
                    if ($membership === null) {
                        $membership = QueueMembership::query()->create([
                            'id' => RandomIdentifier::new(), 'actor_id' => $memberActorId, 'queue_key' => $queueKey,
                            'organization_id' => $resolvedOrganizationId, 'branch_id' => $branchId,
                            'lifecycle_state' => 'active', 'effective_from' => now(), 'created_by' => $manager->actorId,
                        ]);
                    } else {
                        $membership->forceFill(['lifecycle_state' => 'active', 'effective_from' => now(), 'effective_to' => null, 'created_by' => $manager->actorId])->save();
                    }
                    $event = $this->audit->record($manager->actorId, 'workflow.queue.grant', 'queue_membership', $membership->id, null, ['actor_id' => $memberActorId, 'queue_key' => $queueKey, 'organization_id' => $resolvedOrganizationId, 'branch_id' => $branchId]);

                    return ['membership_id' => $membership->id, 'correlation_id' => $event->correlation_id];
                }),
            );
        } catch (AuthorizationDenied $denial) {
            $this->attemptedOperation->deniedByActor($denial, $manager, 'workflow.queue.grant', 'queue_membership', $memberActorId);
        }
    }

    /** @return array{membership_id: string, correlation_id: string} */
    public function revoke(Actor $manager, QueueMembership $membership, string $idempotencyKey): array
    {
        $payload = hash('sha256', implode('|', ['workflow.queue.revoke', $membership->id, $manager->actorId]));

        try {
            return $this->idempotency->execute('workflow.queue.revoke', $idempotencyKey, $payload,
                fn (): array => DB::transaction(function () use ($manager, $membership): array {
                    /** @var QueueMembership $locked */
                    $locked = QueueMembership::query()->whereKey($membership->id)->lockForUpdate()->firstOrFail();
                    $resolvedOrganizationId = $this->resolveOrganizationId($locked->branch_id, (string) $locked->organization_id);
                    $this->authorize($manager, $locked->branch_id, $resolvedOrganizationId);
                    if ($locked->lifecycle_state !== 'active') {
                        throw BusinessRejection::forCode('workflow.queue_membership_transition', 'only an active queue membership may be revoked');
                    }
                    $locked->forceFill(['lifecycle_state' => 'revoked', 'effective_to' => now()])->save();
                    $event = $this->audit->record($manager->actorId, 'workflow.queue.revoke', 'queue_membership', $locked->id, ['lifecycle_state' => 'active', 'organization_id' => $locked->organization_id, 'branch_id' => $locked->branch_id], ['lifecycle_state' => 'revoked', 'organization_id' => $locked->organization_id, 'branch_id' => $locked->branch_id]);

                    return ['membership_id' => $locked->id, 'correlation_id' => $event->correlation_id];
                }),
            );
        } catch (AuthorizationDenied $denial) {
            $this->attemptedOperation->deniedByActor($denial, $manager, 'workflow.queue.revoke', 'queue_membership', $membership->id);
        }
    }

    private function authorize(Actor $actor, ?string $branchId, string $organizationId): void
    {
        if ($branchId === null || trim((string) $branchId) === '') {
            $outcome = app(AccessDecision::class)->decide($actor, self::CAPABILITY, StructureScope::organization($organizationId));
            if (! $outcome->allowed) {
                throw AuthorizationDenied::forCode('workflow.queue_manage_denied', $outcome->reason);
            }

            return;
        }

        $this->scoped->require($actor, self::CAPABILITY, $branchId, 'workflow.queue_manage_denied');
    }

    private function resolveOrganizationId(?string $branchId, ?string $organizationId): string
    {
        $branchId = trim((string) ($branchId ?? ''));
        $organizationId = trim((string) ($organizationId ?? ''));
        if ($branchId !== '') {
            /** @var Branch|null $branch */
            $branch = Branch::query()->whereKey($branchId)->first();
            if ($branch === null || $branch->lifecycle_state !== 'active') {
                throw BusinessRejection::forCode('workflow.queue_branch_unknown', 'a branch queue membership requires an active branch');
            }
            try {
                $scope = $branch->structureScope();
            } catch (ModelNotFoundException) {
                throw BusinessRejection::forCode('workflow.queue_branch_unknown', 'a branch queue membership requires current active campus provenance');
            }
            $branchOrganization = trim($scope->organizationId);
            if ($branchOrganization === '' || ($organizationId !== '' && $organizationId !== $branchOrganization)) {
                throw BusinessRejection::forCode('workflow.queue_organization_invalid', 'queue membership branch and organization provenance must agree');
            }
            $organizationId = $branchOrganization;
        }
        if ($organizationId === '' || ! Organization::query()->whereKey($organizationId)->where('lifecycle_state', 'active')->exists()) {
            throw BusinessRejection::forCode('workflow.queue_organization_required', 'an organization-scoped queue membership requires an active organization');
        }

        return $organizationId;
    }
}
