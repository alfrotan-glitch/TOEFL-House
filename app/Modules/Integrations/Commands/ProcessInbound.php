<?php

declare(strict_types=1);

namespace App\Modules\Integrations\Commands;

use App\Modules\Audit\AttemptedOperation;
use App\Modules\Audit\AuditRecorder;
use App\Modules\Integrations\Models\InboundEvent;
use App\Support\Authorization\AccessDecision;
use App\Support\Authorization\Actor;
use App\Support\Errors\AuthorizationDenied;
use App\Support\Errors\BusinessRejection;
use App\Support\Idempotency\IdempotentExecution;
use Illuminate\Support\Facades\DB;

/**
 * Inbound processing is exactly-once per accepted event: the row moves
 * received → processed under a conditional update, so a replayed or
 * concurrent processing call finds the original outcome and never
 * re-executes side effects.
 */
final class ProcessInbound
{
    public const CAPABILITY = 'integrations.inbound';

    public function __construct(
        private readonly AccessDecision $access,
        private readonly IdempotentExecution $idempotency,
        private readonly AuditRecorder $audit,
        private readonly AttemptedOperation $attemptedOperation,
    ) {}

    /** @return array{event_id: string, status: string, already_processed: bool} */
    public function process(Actor $actor, InboundEvent $event, string $idempotencyKey): array
    {
        $payload = hash('sha256', implode('|', ['integrations.inbound.process', $event->id, $actor->actorId]));

        try {
            return $this->idempotency->execute('integrations.inbound.process', $idempotencyKey, $payload,
                fn (): array => DB::transaction(function () use ($actor, $event): array {
                    $this->require($actor);

                    /** @var InboundEvent $locked */
                    $locked = InboundEvent::query()->whereKey($event->id)->lockForUpdate()->firstOrFail();
                    if ($locked->status === 'rejected') {
                        throw BusinessRejection::forCode('integrations.inbound_rejected', 'rejected evidence is not processed');
                    }
                    if ($locked->status === 'processed') {
                        return ['event_id' => $locked->id, 'status' => 'processed', 'already_processed' => true];
                    }
                    if ($locked->status === 'duplicate') {
                        return ['event_id' => $locked->id, 'status' => 'duplicate', 'already_processed' => true];
                    }

                    $locked->forceFill(['status' => 'processed', 'processed_at' => now(), 'processed_by' => $actor->actorId]);
                    $locked->save();
                    $this->audit->record($actor->actorId, 'integrations.inbound.processed', 'inbound_event', $locked->id, null, ['external_id' => $locked->external_id, 'event_type' => $locked->event_type]);

                    return ['event_id' => $locked->id, 'status' => 'processed', 'already_processed' => false];
                }),
            );
        } catch (AuthorizationDenied $denial) {
            $this->attemptedOperation->deniedByActor($denial, $actor, 'integrations.inbound.process', 'inbound_event', $event->id);
        }
    }

    private function require(Actor $actor): void
    {
        $outcome = $this->access->decide($actor, self::CAPABILITY, null);
        if (! $outcome->allowed) {
            throw AuthorizationDenied::forCode('integrations.inbound_denied', $outcome->reason);
        }
    }
}
