<?php

declare(strict_types=1);

namespace App\Modules\Integrations\Commands;

use App\Modules\Audit\AttemptedOperation;
use App\Modules\Audit\AuditRecorder;
use App\Modules\Integrations\Models\IntegrationDelivery;
use App\Support\Authorization\AccessDecision;
use App\Support\Authorization\Actor;
use App\Support\Errors\AuthorizationDenied;
use App\Support\Errors\BusinessRejection;
use App\Support\Idempotency\IdempotentExecution;
use Illuminate\Support\Facades\DB;

/**
 * Dead-letter manual review: a reviewer may requeue a dead-lettered
 * delivery — an audited human decision that reopens the bounded retry
 * window; the delivery keeps its identity and the requeue count records
 * the intervention.
 */
final class RequeueDelivery
{
    public const CAPABILITY = 'integrations.review';

    public function __construct(
        private readonly AccessDecision $access,
        private readonly IdempotentExecution $idempotency,
        private readonly AuditRecorder $audit,
        private readonly AttemptedOperation $attemptedOperation,
    ) {}

    /** @return array{delivery_id: string, correlation_id: string} */
    public function requeue(Actor $actor, IntegrationDelivery $delivery, string $idempotencyKey): array
    {
        $payload = hash('sha256', implode('|', ['integrations.delivery.requeue', $delivery->id, $actor->actorId]));

        try {
            return $this->idempotency->execute('integrations.delivery.requeue', $idempotencyKey, $payload,
                fn (): array => DB::transaction(function () use ($actor, $delivery): array {
                    $this->require($actor);

                    /** @var IntegrationDelivery $locked */
                    $locked = IntegrationDelivery::query()->whereKey($delivery->id)->lockForUpdate()->firstOrFail();
                    if ($locked->status !== 'dead_letter') {
                        throw BusinessRejection::forCode('integrations.requeue_not_dead', 'only dead-lettered deliveries are requeued through review');
                    }

                    $locked->forceFill([
                        'status' => 'queued',
                        'attempts' => 0,
                        'requeues' => $locked->requeues + 1,
                        'next_run_at' => null,
                        'last_error' => null,
                    ]);
                    $locked->save();
                    $event = $this->audit->record($actor->actorId, 'integrations.delivery.requeue', 'integration_delivery', $locked->id, null, ['requeues' => $locked->requeues]);

                    return ['delivery_id' => $locked->id, 'correlation_id' => $event->correlation_id];
                }),
            );
        } catch (AuthorizationDenied $denial) {
            $this->attemptedOperation->deniedByActor($denial, $actor, 'integrations.delivery.requeue', 'integration_delivery', $delivery->id);
        }
    }

    private function require(Actor $actor): void
    {
        $outcome = $this->access->decide($actor, self::CAPABILITY, null);
        if (! $outcome->allowed) {
            throw AuthorizationDenied::forCode('integrations.review_denied', $outcome->reason);
        }
    }
}
