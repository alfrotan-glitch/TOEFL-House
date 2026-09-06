<?php

declare(strict_types=1);

namespace App\Modules\Organization\Commands;

use App\Modules\Audit\AttemptedOperation;
use App\Modules\Audit\AuditRecorder;
use App\Modules\Organization\Domain\OrganizationLifecycle;
use App\Modules\Organization\Models\Branch;
use App\Modules\Organization\Models\Campus;
use App\Modules\Organization\Models\CampusAssignment;
use App\Modules\Organization\Models\Department;
use App\Modules\Organization\Models\Organization;
use App\Support\Authorization\AccessDecision;
use App\Support\Authorization\StructureDecision;
use App\Support\Authorization\StructureScope;
use App\Support\Errors\AuthorizationDenied;
use App\Support\Errors\BusinessRejection;
use App\Support\Idempotency\IdempotentExecution;
use App\Support\Identifiers\RandomIdentifier;
use Carbon\CarbonImmutable;
use Illuminate\Database\Eloquent\Model;
use Illuminate\Support\Facades\DB;

/**
 * Creation of structure units. New units start in draft; a branch receives
 * its initial effective-dated campus attribution in the same transaction.
 * Parents must be active before they can own child units.
 */
final class CreateStructureUnit
{
    public function __construct(
        private readonly AccessDecision $access,
        private readonly IdempotentExecution $idempotency,
        private readonly AuditRecorder $audit,
        private readonly AttemptedOperation $attemptedOperation,
    ) {}

    /** @return array{id: string, unit_type: string, correlation_id: string} */
    public function createOrganization(StructureDecision $decision, string $name, string $idempotencyKey): array
    {
        $payload = $this->payload('organization', null, $name, $decision);

        try {
            return $this->idempotency->execute('organization.structure.create', $idempotencyKey, $payload,
                fn (): array => DB::transaction(function () use ($decision, $name): array {
                    $decision->authorize($this->access, null);

                    return $this->insertUnit(new Organization, 'organization', ['name' => $name], $decision);
                }),
            );
        } catch (AuthorizationDenied $denial) {
            $this->attemptedOperation->deniedByActor($denial, $decision->initiator, 'organization.structure.create', 'organization', '');
        }
    }

    /** @return array{id: string, unit_type: string, correlation_id: string} */
    public function createCampus(StructureDecision $decision, string $organizationId, string $name, string $idempotencyKey): array
    {
        $payload = $this->payload('campus', $organizationId, $name, $decision);

        try {
            return $this->idempotency->execute('organization.structure.create', $idempotencyKey, $payload,
                fn (): array => DB::transaction(function () use ($decision, $organizationId, $name): array {
                    /** @var Organization $organization */
                    $organization = Organization::query()->whereKey($organizationId)->lockForUpdate()->firstOrFail();
                    $this->requireActiveParent($organization->lifecycle_state, 'organization');
                    $decision->authorize($this->access, new StructureScope($organization->id));

                    return $this->insertUnit(new Campus, 'campus', ['organization_id' => $organization->id, 'name' => $name], $decision);
                }),
            );
        } catch (AuthorizationDenied $denial) {
            $this->attemptedOperation->deniedByActor($denial, $decision->initiator, 'organization.structure.create', 'campus', $organizationId);
        }
    }

    /** @return array{id: string, unit_type: string, correlation_id: string} */
    public function createBranch(StructureDecision $decision, string $campusId, string $name, CarbonImmutable $effectiveFrom, string $idempotencyKey): array
    {
        $payload = $this->payload('branch', $campusId, $name, $decision, $effectiveFrom);

        try {
            return $this->idempotency->execute('organization.structure.create', $idempotencyKey, $payload,
                fn (): array => DB::transaction(function () use ($decision, $campusId, $name, $effectiveFrom): array {
                    /** @var Campus $campus */
                    $campus = Campus::query()->whereKey($campusId)->lockForUpdate()->firstOrFail();
                    $this->requireActiveParent($campus->lifecycle_state, 'campus');
                    $decision->authorize($this->access, new StructureScope($campus->organization_id, $campus->id));

                    $outcome = $this->insertUnit(new Branch, 'branch', ['name' => $name], $decision);
                    CampusAssignment::query()->create([
                        'id' => RandomIdentifier::new(),
                        'branch_id' => $outcome['id'],
                        'campus_id' => $campus->id,
                        'effective_from' => $effectiveFrom->startOfDay()->toDateString(),
                        'effective_to' => null,
                        'transfer_correlation_id' => $outcome['correlation_id'],
                    ]);
                    $this->audit->record(
                        $decision->initiator->actorId,
                        'organization.branch.assign_campus',
                        'branch',
                        $outcome['id'],
                        null,
                        ['campus_id' => $campus->id, 'effective_from' => $effectiveFrom->startOfDay()->toDateString()],
                        $outcome['correlation_id'],
                    );

                    return $outcome;
                }),
            );
        } catch (AuthorizationDenied $denial) {
            $this->attemptedOperation->deniedByActor($denial, $decision->initiator, 'organization.structure.create', 'branch', $campusId);
        }
    }

    /** @return array{id: string, unit_type: string, correlation_id: string} */
    public function createDepartment(StructureDecision $decision, string $scopeType, string $scopeId, string $name, string $idempotencyKey): array
    {
        $payload = $this->payload('department', $scopeId, $name, $decision, null, $scopeType);

        try {
            return $this->idempotency->execute('organization.structure.create', $idempotencyKey, $payload,
                fn (): array => DB::transaction(function () use ($decision, $scopeType, $scopeId, $name): array {
                    $scope = $this->resolveParentScope($scopeType, $scopeId);
                    $decision->authorize($this->access, $scope);

                    return $this->insertUnit(new Department, 'department', [
                        'name' => $name,
                        'scope_type' => $scopeType,
                        'scope_id' => $scopeId,
                    ], $decision);
                }),
            );
        } catch (AuthorizationDenied $denial) {
            $this->attemptedOperation->deniedByActor($denial, $decision->initiator, 'organization.structure.create', 'department', $scopeId);
        }
    }

    private function resolveParentScope(string $scopeType, string $scopeId): StructureScope
    {
        if ($scopeType === 'organization') {
            /** @var Organization $organization */
            $organization = Organization::query()->whereKey($scopeId)->lockForUpdate()->firstOrFail();
            $this->requireActiveParent($organization->lifecycle_state, 'organization');

            return new StructureScope($organization->id);
        }
        if ($scopeType === 'campus') {
            /** @var Campus $campus */
            $campus = Campus::query()->whereKey($scopeId)->lockForUpdate()->firstOrFail();
            $this->requireActiveParent($campus->lifecycle_state, 'campus');

            return new StructureScope($campus->organization_id, $campus->id);
        }
        if ($scopeType === 'branch') {
            /** @var Branch $branch */
            $branch = Branch::query()->whereKey($scopeId)->lockForUpdate()->firstOrFail();
            $assignment = $branch->activeCampusAssignment();
            if ($assignment === null) {
                throw BusinessRejection::forCode('department.branch_without_campus', 'branch has no effective campus attribution');
            }
            $this->requireActiveParent($branch->lifecycle_state, 'branch');
            /** @var Campus $campus */
            $campus = Campus::query()->whereKey($assignment->campus_id)->firstOrFail();

            return new StructureScope($campus->organization_id, $campus->id, $branch->id);
        }

        throw BusinessRejection::forCode('department.scope_type_unknown', sprintf('unknown department scope type %s', $scopeType));
    }

    private function requireActiveParent(string $lifecycleState, string $unitType): void
    {
        if ($lifecycleState !== OrganizationLifecycle::STATE_ACTIVE) {
            throw BusinessRejection::forCode(
                'organization.parent_not_active',
                sprintf('%s owning the new unit must be active', $unitType),
            );
        }
    }

    /**
     * @param  array<string, mixed>  $attributes
     * @return array{id: string, unit_type: string, correlation_id: string}
     */
    private function insertUnit(Model $unit, string $unitType, array $attributes, StructureDecision $decision): array
    {
        $unit->forceFill(array_merge($attributes, [
            'id' => RandomIdentifier::new(),
            'lifecycle_state' => OrganizationLifecycle::STATE_DRAFT,
        ]));
        $unit->save();

        $afterState = array_merge($attributes, ['lifecycle_state' => OrganizationLifecycle::STATE_DRAFT]);
        /** @var string $unitId */
        $unitId = $unit->getKey();
        $event = $this->audit->record(
            $decision->initiator->actorId,
            'organization.structure.create',
            $unitType,
            $unitId,
            null,
            $afterState,
        );

        return ['id' => $unitId, 'unit_type' => $unitType, 'correlation_id' => $event->correlation_id];
    }

    private function payload(string $unitType, ?string $parentId, string $name, StructureDecision $decision, ?CarbonImmutable $effectiveFrom = null, ?string $scopeType = null): string
    {
        return hash('sha256', implode('|', [
            'organization.structure.create',
            $unitType,
            $parentId ?? '',
            $name,
            implode(',', $decision->participantIds()),
            $effectiveFrom?->toDateString() ?? '',
            $scopeType ?? '',
        ]));
    }
}
