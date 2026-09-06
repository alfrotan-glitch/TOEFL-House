<?php

declare(strict_types=1);

namespace App\Modules\Communication\Commands;

use App\Modules\Audit\AttemptedOperation;
use App\Modules\Audit\AuditRecorder;
use App\Modules\Communication\Models\Notification;
use App\Modules\Organization\Models\Branch;
use App\Modules\Organization\Models\Organization;
use App\Support\Authorization\AccessDecision;
use App\Support\Authorization\Actor;
use App\Support\Authorization\BranchScopedAccess;
use App\Support\Authorization\StructureScope;
use App\Support\Errors\AuthorizationDenied;
use App\Support\Idempotency\IdempotentExecution;
use Illuminate\Database\Eloquent\ModelNotFoundException;
use Illuminate\Support\Facades\DB;

/**
 * Owns notification read/dismiss projection state only. Recipient identity
 * and current notification lifecycle are rechecked under lock; this command
 * never acknowledges the linked domain action.
 */
final class MaintainNotification
{
    public const CAPABILITY = 'communication.notification.read';

    private readonly BranchScopedAccess $scoped;

    public function __construct(
        private readonly AccessDecision $access,
        private readonly IdempotentExecution $idempotency,
        private readonly AuditRecorder $audit,
        private readonly AttemptedOperation $attemptedOperation,
    ) {
        $this->scoped = new BranchScopedAccess($access);
    }

    /** @return array{notification_id: string, status: string, correlation_id: string} */
    public function transition(Actor $actor, Notification $notification, string $toState, string $idempotencyKey): array
    {
        $payload = hash('sha256', implode('|', ['communication.notification.'.$toState, $notification->id, $actor->actorId]));

        try {
            return $this->idempotency->execute('communication.notification.'.$toState, $idempotencyKey, $payload,
                fn (): array => DB::transaction(function () use ($actor, $notification, $toState): array {
                    /** @var Notification $locked */
                    $locked = Notification::query()->whereKey($notification->id)->lockForUpdate()->firstOrFail();
                    if ($locked->recipient_actor_id !== $actor->actorId) {
                        throw AuthorizationDenied::forCode('communication.notification_recipient_denied', 'only the notification recipient may change read state');
                    }
                    if ($locked->branch_id !== null && trim((string) $locked->branch_id) !== '') {
                        if ($locked->scope_type !== 'branch') {
                            throw AuthorizationDenied::forCode('communication.notification_denied', 'notification scope provenance is inconsistent');
                        }
                        if (trim((string) $locked->organization_id) === '') {
                            throw AuthorizationDenied::forCode('communication.notification_denied', 'branch notification provenance is incomplete');
                        }
                        /** @var Branch $branch */
                        $branch = Branch::query()->whereKey($locked->branch_id)->first();
                        if ($branch === null) {
                            throw AuthorizationDenied::forCode('communication.notification_denied', 'notification branch provenance is unknown');
                        }
                        try {
                            $scope = $branch->structureScope();
                        } catch (ModelNotFoundException) {
                            throw AuthorizationDenied::forCode('communication.notification_denied', 'notification branch provenance is not resolvable');
                        }
                        if (trim($scope->organizationId) !== trim((string) $locked->organization_id)) {
                            throw AuthorizationDenied::forCode('communication.notification_denied', 'notification branch and organization provenance no longer agree');
                        }
                        $this->scoped->require($actor, self::CAPABILITY, $locked->branch_id, 'communication.notification_denied', (string) $locked->organization_id);
                    } else {
                        if ($locked->scope_type !== 'organization') {
                            throw AuthorizationDenied::forCode('communication.notification_denied', 'notification scope provenance is unknown');
                        }
                        $organization = Organization::query()->whereKey($locked->organization_id)->first();
                        if ($organization === null || $organization->lifecycle_state !== 'active') {
                            throw AuthorizationDenied::forCode('communication.notification_denied', 'notification organization provenance is not active');
                        }
                        $outcome = $this->access->decide($actor, self::CAPABILITY, new StructureScope($organization->id));
                        if (! $outcome->allowed) {
                            throw AuthorizationDenied::forCode('communication.notification_denied', $outcome->reason);
                        }
                    }
                    if (! in_array($toState, ['read', 'dismissed'], true) || $locked->lifecycle_state === 'dismissed') {
                        throw \App\Support\Errors\BusinessRejection::forCode('communication.notification_transition', 'notification state can move from unread/read to read or dismissed');
                    }

                    $before = ['lifecycle_state' => $locked->lifecycle_state, 'branch_id' => $locked->branch_id, 'organization_id' => $locked->organization_id];
                    $changes = ['lifecycle_state' => $toState];
                    if ($toState === 'read') {
                        $changes['read_at'] = now();
                    } else {
                        $changes['dismissed_at'] = now();
                    }
                    $locked->forceFill($changes)->save();
                    $event = $this->audit->record($actor->actorId, 'communication.notification.'.$toState, 'notification', $locked->id, $before, ['lifecycle_state' => $toState, 'branch_id' => $locked->branch_id, 'organization_id' => $locked->organization_id]);

                    return ['notification_id' => $locked->id, 'status' => $toState, 'correlation_id' => $event->correlation_id];
                }),
            );
        } catch (AuthorizationDenied $denial) {
            $this->attemptedOperation->deniedByActor($denial, $actor, 'communication.notification.'.$toState, 'notification', $notification->id);
        }
    }
}
