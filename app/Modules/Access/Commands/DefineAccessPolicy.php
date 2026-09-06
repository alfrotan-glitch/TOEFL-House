<?php

declare(strict_types=1);

namespace App\Modules\Access\Commands;

use App\Modules\Access\Models\AccessPolicy;
use App\Modules\Audit\AttemptedOperation;
use App\Modules\Audit\AuditRecorder;
use App\Support\Authorization\AccessDecision;
use App\Support\Authorization\Actor;
use App\Support\Errors\AuthorizationDenied;
use App\Support\Idempotency\IdempotentExecution;
use App\Support\Identifiers\RandomIdentifier;
use Carbon\CarbonImmutable;
use Illuminate\Support\Facades\DB;

/**
 * Publishes a policy version: binds a position to a role, or grants a
 * permission to a role. A new version closes the overlapping open row;
 * active history is never rewritten. Policy changes are themselves
 * authorized and audited.
 */
final class DefineAccessPolicy
{
    public const CAPABILITY = 'access.define_policy';

    public function __construct(
        private readonly AccessDecision $access,
        private readonly IdempotentExecution $idempotency,
        private readonly AuditRecorder $audit,
        private readonly AttemptedOperation $attemptedOperation,
    ) {}

    /** @return array{policy_id: string, correlation_id: string} */
    public function bindPositionRole(Actor $publisher, string $positionId, string $roleId, CarbonImmutable $effectiveFrom, string $idempotencyKey): array
    {
        return $this->publish($publisher, 'position', $positionId, 'role', $roleId, null, $effectiveFrom, $idempotencyKey);
    }

    /** @return array{policy_id: string, correlation_id: string} */
    public function grantRolePermission(Actor $publisher, string $roleId, string $permission, CarbonImmutable $effectiveFrom, string $idempotencyKey): array
    {
        return $this->publish($publisher, 'role', $roleId, 'permission', null, $permission, $effectiveFrom, $idempotencyKey);
    }

    /** @return array{policy_id: string, correlation_id: string} */
    private function publish(Actor $publisher, string $bindingType, string $bindingId, string $grantsType, ?string $grantsId, ?string $permission, CarbonImmutable $effectiveFrom, string $idempotencyKey): array
    {
        $payload = hash('sha256', implode('|', ['access.policy.publish', $bindingType, $bindingId, $grantsType, $grantsId ?? '', $permission ?? '', $effectiveFrom->toDateString(), $publisher->actorId]));

        try {
            return $this->idempotency->execute('access.policy.publish', $idempotencyKey, $payload,
                fn (): array => DB::transaction(function () use ($publisher, $bindingType, $bindingId, $grantsType, $grantsId, $permission, $effectiveFrom): array {
                    $this->requireCapability($publisher);

                    $open = AccessPolicy::query()
                        ->where('binding_type', $bindingType)
                        ->where('binding_id', $bindingId)
                        ->where('grants_type', $grantsType)
                        ->when($grantsType === AccessPolicy::GRANTS_PERMISSION, fn ($query) => $query->where('permission', $permission))
                        ->whereNull('effective_to')
                        ->lockForUpdate()
                        ->get();
                    foreach ($open as $openRow) {
                        $openRow->effective_to = $effectiveFrom->startOfDay()->toDateString();
                        $openRow->save();
                    }

                    $policy = AccessPolicy::query()->create([
                        'id' => RandomIdentifier::new(),
                        'binding_type' => $bindingType,
                        'binding_id' => $bindingId,
                        'grants_type' => $grantsType,
                        'grants_id' => $grantsId,
                        'permission' => $permission ?? '',
                        'effective_from' => $effectiveFrom->startOfDay()->toDateString(),
                        'effective_to' => null,
                        'published_by' => $publisher->actorId,
                    ]);

                    $event = $this->audit->record($publisher->actorId, 'access.policy.publish', 'access_policy', $policy->id, null, [
                        'binding' => $bindingType.':'.$bindingId,
                        'grants' => $grantsType.':'.($grantsId ?? $permission ?? ''),
                        'effective_from' => $policy->effective_from,
                    ]);

                    return ['policy_id' => $policy->id, 'correlation_id' => $event->correlation_id];
                }),
            );
        } catch (AuthorizationDenied $denial) {
            $this->attemptedOperation->deniedByActor($denial, $publisher, 'access.policy.publish', 'access_policy', $bindingId);
        }
    }

    private function requireCapability(Actor $publisher): void
    {
        $outcome = $this->access->decide($publisher, self::CAPABILITY, null);
        if (! $outcome->allowed) {
            throw AuthorizationDenied::forCode('access.policy_denied', $outcome->reason);
        }
    }
}
