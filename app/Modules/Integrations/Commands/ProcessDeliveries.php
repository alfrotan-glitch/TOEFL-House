<?php

declare(strict_types=1);

namespace App\Modules\Integrations\Commands;

use App\Modules\Audit\AttemptedOperation;
use App\Modules\Integrations\Domain\DeliveryProcessor;
use App\Modules\Integrations\Models\IntegrationDelivery;
use App\Support\Authorization\AccessDecision;
use App\Support\Authorization\Actor;
use App\Support\Errors\AuthorizationDenied;
use App\Support\Idempotency\IdempotentExecution;
use Throwable;

/**
 * Worker entry to the delivery core: every due delivery is processed in
 * its own transaction (partial failure leaves siblings intact) through
 * the same core the scheduled sweep uses.
 */
final class ProcessDeliveries
{
    public const CAPABILITY = 'integrations.process';

    public function __construct(
        private readonly AccessDecision $access,
        private readonly IdempotentExecution $idempotency,
        private readonly AttemptedOperation $attemptedOperation,
        private readonly DeliveryProcessor $processor,
    ) {}

    /** @return array{results: list<array{delivery_id: string, outcome: string, attempts: int}>, considered: int} */
    public function processDue(Actor $actor, string $idempotencyKey): array
    {
        $payload = hash('sha256', implode('|', ['integrations.delivery.process', now()->toIso8601String(), $actor->actorId]));

        try {
            return $this->idempotency->execute('integrations.delivery.process', $idempotencyKey, $payload,
                function () use ($actor): array {
                    $this->require($actor);
                    $results = [];
                    $due = IntegrationDelivery::query()
                        ->whereIn('status', ['queued', 'failed'])
                        ->where(fn ($query) => $query->whereNull('next_run_at')->orWhere('next_run_at', '<=', now()))
                        ->orderBy('created_at')
                        ->pluck('id');
                    foreach ($due as $deliveryId) {
                        try {
                            $results[] = $this->processor->processId($deliveryId, $actor);
                        } catch (Throwable) {
                            // an aborted attempt rolls back its own delivery only; the sweep continues
                            $results[] = ['delivery_id' => $deliveryId, 'outcome' => 'attempt_aborted', 'attempts' => 0];
                        }
                    }

                    return ['results' => $results, 'considered' => count($results)];
                },
            );
        } catch (AuthorizationDenied $denial) {
            $this->attemptedOperation->deniedByActor($denial, $actor, 'integrations.delivery.process', 'integration_delivery', 'due-sweep');
        }
    }

    private function require(Actor $actor): void
    {
        $outcome = $this->access->decide($actor, self::CAPABILITY, null);
        if (! $outcome->allowed) {
            throw AuthorizationDenied::forCode('integrations.process_denied', $outcome->reason);
        }
    }
}
