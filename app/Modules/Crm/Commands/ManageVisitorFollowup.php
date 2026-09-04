<?php

declare(strict_types=1);

namespace App\Modules\Crm\Commands;

use App\Modules\Audit\AttemptedOperation;
use App\Modules\Audit\AuditRecorder;
use App\Modules\Crm\Domain\CrmAccess;
use App\Modules\Crm\Models\VisitorFollowup;
use App\Support\Authorization\Actor;
use App\Support\Errors\AuthorizationDenied;
use App\Support\Errors\BusinessRejection;
use App\Support\Idempotency\IdempotentExecution;
use Illuminate\Support\Facades\DB;

/**
 * Advance a scheduled follow-up to done/cancelled. Follow-up content is fixed
 * at creation; assignment changes are a reassignment (new lifecycle state),
 * never a content rewrite.
 */
final class ManageVisitorFollowup
{
    public const CAPABILITY = 'crm.followup';

    public function __construct(
        private readonly CrmAccess $access,
        private readonly IdempotentExecution $idempotency,
        private readonly AuditRecorder $audit,
        private readonly AttemptedOperation $attemptedOperation,
    ) {}

    /** @return array{followup_id: string, status: string, correlation_id: string} */
    public function complete(Actor $actor, VisitorFollowup $followup, string $idempotencyKey): array
    {
        return $this->transition($actor, $followup, VisitorFollowup::STATUS_DONE, $idempotencyKey);
    }

    /** @return array{followup_id: string, status: string, correlation_id: string} */
    public function cancel(Actor $actor, VisitorFollowup $followup, string $idempotencyKey): array
    {
        return $this->transition($actor, $followup, VisitorFollowup::STATUS_CANCELLED, $idempotencyKey);
    }

    /** @return array{followup_id: string, status: string, correlation_id: string} */
    private function transition(Actor $actor, VisitorFollowup $followup, string $toStatus, string $idempotencyKey): array
    {
        $payload = hash('sha256', implode('|', ['crm.followup.transition', $followup->id, $toStatus, $actor->actorId]));

        try {
            return $this->idempotency->execute('crm.followup.transition', $idempotencyKey, $payload,
                fn (): array => DB::transaction(function () use ($actor, $followup, $toStatus): array {
                    /** @var VisitorFollowup $locked */
                    $locked = VisitorFollowup::query()->whereKey($followup->id)->lockForUpdate()->firstOrFail();
                    $this->access->require($actor, self::CAPABILITY, $locked->visitor?->origin_branch_id, 'crm.followup_denied');
                    if ($locked->status !== VisitorFollowup::STATUS_OPEN) {
                        throw BusinessRejection::forCode('crm.followup_invalid_transition', sprintf('a %s follow-up cannot transition to %s', $locked->status, $toStatus));
                    }

                    $before = ['status' => $locked->status];
                    $locked->forceFill([
                        'status' => $toStatus,
                        'completed_by' => $actor->actorId,
                        'completed_at' => now()->toDateTimeString(),
                    ]);
                    $locked->save();
                    $event = $this->audit->record($actor->actorId, 'crm.followup.transition', 'visitor_followup', $locked->id, $before, [
                        'status' => $toStatus,
                    ]);

                    return ['followup_id' => $locked->id, 'status' => $toStatus, 'correlation_id' => $event->correlation_id];
                }),
            );
        } catch (AuthorizationDenied $denial) {
            $this->attemptedOperation->deniedByActor($denial, $actor, 'crm.followup.transition', 'visitor_followup', $followup->id);
        }
    }
}
