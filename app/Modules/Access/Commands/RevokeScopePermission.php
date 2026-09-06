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
use Illuminate\Support\Facades\DB;

/**
 * Revocation terminates an active grant; the row and its history are
 * retained and authority never survives revocation.
 */
final class RevokeScopePermission
{
    public const CAPABILITY = 'access.revoke';

    public function __construct(
        private readonly AccessDecision $access,
        private readonly IdempotentExecution $idempotency,
        private readonly AuditRecorder $audit,
        private readonly AttemptedOperation $attemptedOperation,
    ) {}

    /** @return array{grant_id: string, lifecycle_state: string, correlation_id: string} */
    public function revoke(Actor $revoker, ScopeGrant $grant, string $idempotencyKey): array
    {
        $payload = hash('sha256', implode('|', ['access.revoke', $grant->id, $revoker->actorId]));

        try {
            return $this->idempotency->execute('access.revoke', $idempotencyKey, $payload,
                fn (): array => DB::transaction(function () use ($revoker, $grant): array {
                    /** @var ScopeGrant $locked */
                    $locked = ScopeGrant::query()->whereKey($grant->id)->lockForUpdate()->firstOrFail();
                    $scope = new StructureScope(
                        $locked->scope_type === 'organization' ? $locked->scope_id : $this->parentOrganization($locked),
                        $locked->scope_type === 'campus' ? $locked->scope_id : null,
                        $locked->scope_type === 'branch' ? $locked->scope_id : null,
                        $locked->scope_type === 'department' ? $locked->scope_id : null,
                    );
                    $outcome = $this->access->decide($revoker, self::CAPABILITY, $scope);
                    if (! $outcome->allowed) {
                        throw AuthorizationDenied::forCode('access.revoke_denied', $outcome->reason);
                    }

                    AccessLifecycle::requireTransition($locked->lifecycle_state, AccessLifecycle::STATE_REVOKED);

                    $before = ['lifecycle_state' => $locked->lifecycle_state];
                    $locked->forceFill(['lifecycle_state' => AccessLifecycle::STATE_REVOKED]);
                    $locked->save();

                    $event = $this->audit->record($revoker->actorId, 'access.revoke', 'scope_grant', $locked->id, $before, ['lifecycle_state' => AccessLifecycle::STATE_REVOKED]);

                    return ['grant_id' => $locked->id, 'lifecycle_state' => AccessLifecycle::STATE_REVOKED, 'correlation_id' => $event->correlation_id];
                }),
            );
        } catch (AuthorizationDenied $denial) {
            $this->attemptedOperation->deniedByActor($denial, $revoker, 'access.revoke', 'scope_grant', $grant->id);
        }
    }

    private function parentOrganization(ScopeGrant $grant): string
    {
        return match ($grant->scope_type) {
            'campus' => (string) (Campus::query()->whereKey($grant->scope_id)->value('organization_id')
                ?? throw BusinessRejection::forCode('access.scope_unavailable', 'campus scope does not resolve')),
            default => '',
        };
    }
}
