<?php

declare(strict_types=1);

namespace App\Modules\Integrations\Domain;

use App\Modules\Audit\AuditRecorder;
use App\Modules\Integrations\Models\IntegrationDelivery;
use App\Modules\Integrations\Models\IntegrationEndpoint;
use App\Support\Authorization\Actor;
use Illuminate\Support\Facades\DB;
use Throwable;

/**
 * At-least-once outbound delivery core. A delivery is claimed and committed
 * before transport I/O, then finalized under a fresh row lock. The external
 * adapter receives the stable idempotency key, so lease expiry or a process
 * crash can safely replay the send without holding a database transaction
 * open across network I/O.
 */
final class DeliveryProcessor
{
    public function __construct(
        private readonly Transport $transport,
        private readonly AuditRecorder $audit,
    ) {}

    /** @return array{delivery_id: string, outcome: string, attempts: int} */
    public function processId(string $deliveryId, Actor $operator): array
    {
        $claim = DB::transaction(function () use ($deliveryId, $operator): array {
            /** @var IntegrationDelivery|null $delivery */
            $delivery = IntegrationDelivery::query()->whereKey($deliveryId)->lockForUpdate()->first();
            if ($delivery === null) {
                return ['delivery_id' => $deliveryId, 'outcome' => 'skipped_missing', 'attempts' => 0];
            }
            if ($delivery->status === 'delivered' || $delivery->status === 'dead_letter') {
                return ['delivery_id' => $delivery->id, 'outcome' => 'skipped_terminal', 'attempts' => (int) $delivery->attempts];
            }
            if ($delivery->next_run_at !== null && $delivery->next_run_at->isFuture()) {
                return ['delivery_id' => $delivery->id, 'outcome' => 'skipped_not_due', 'attempts' => (int) $delivery->attempts];
            }
            if ($delivery->status === 'processing'
                && $delivery->lease_until !== null
                && $delivery->lease_until->isFuture()) {
                return ['delivery_id' => $delivery->id, 'outcome' => 'skipped_processing', 'attempts' => (int) $delivery->attempts];
            }

            /** @var IntegrationEndpoint $endpoint */
            $endpoint = IntegrationEndpoint::query()->whereKey($delivery->endpoint_id)->firstOrFail();
            if ($endpoint->state !== 'active') {
                $delivery->forceFill([
                    'status' => 'dead_letter',
                    'next_run_at' => null,
                    'lease_until' => null,
                    'last_error' => 'endpoint_retired',
                ]);
                $delivery->save();
                $this->audit->record($operator->actorId, 'integrations.delivery.dead_letter', 'integration_delivery', $delivery->id, null, [
                    'endpoint' => $endpoint->key, 'attempts' => $delivery->attempts, 'reason' => 'endpoint_retired',
                ]);

                return ['delivery_id' => (string) $delivery->id, 'outcome' => 'dead_letter', 'attempts' => (int) $delivery->attempts];
            }
            $attempts = ((int) $delivery->attempts) + 1;
            $delivery->forceFill([
                'status' => 'processing',
                'attempts' => $attempts,
                'lease_until' => now()->addMinutes(5),
                'next_run_at' => null,
                'last_error' => null,
            ]);
            $delivery->save();

            return [
                'delivery_id' => (string) $delivery->id,
                'endpoint_key' => (string) $endpoint->key,
                'contract_action' => (string) $delivery->contract_action,
                'payload' => $delivery->payload ?? [],
                'idempotency_key' => (string) $delivery->idempotency_key,
                'correlation_id' => (string) $delivery->correlation_id,
                'attempts' => $attempts,
                'max_attempts' => (int) $delivery->max_attempts,
            ];
        });

        if (isset($claim['outcome'])) {
            return $claim;
        }

        try {
            /** @var TransportResult $result */
            $result = $this->transport->send(
                (string) $claim['endpoint_key'],
                (string) $claim['contract_action'],
                is_array($claim['payload']) ? $claim['payload'] : [],
                (string) $claim['idempotency_key'],
                (string) $claim['correlation_id'],
            );
        } catch (Throwable $failure) {
            // An adapter exception is retryable unless the bounded attempt
            // count turns it into a dead letter during finalization.
            $result = TransportResult::transientFailure($failure->getMessage());
        }

        /** @var array{delivery_id: string, outcome: string, attempts: int} $final */
        $final = DB::transaction(function () use ($claim, $result, $operator): array {
            /** @var IntegrationDelivery|null $delivery */
            $delivery = IntegrationDelivery::query()->whereKey($claim['delivery_id'])->lockForUpdate()->first();
            if ($delivery === null
                || $delivery->status !== 'processing'
                || (int) $delivery->attempts !== (int) $claim['attempts']) {
                return ['delivery_id' => (string) $claim['delivery_id'], 'outcome' => 'skipped_stale_claim', 'attempts' => (int) $claim['attempts']];
            }

            if ($result->delivered) {
                $delivery->forceFill([
                    'status' => 'delivered',
                    'lease_until' => null,
                    'next_run_at' => null,
                    'last_error' => null,
                    'delivered_ref' => $result->reference,
                    'delivered_at' => now(),
                ]);
                $delivery->save();
                $this->audit->record($operator->actorId, 'integrations.delivery.delivered', 'integration_delivery', $delivery->id, null, [
                    'endpoint' => $claim['endpoint_key'], 'attempts' => $claim['attempts'], 'reference' => $result->reference,
                ]);

                return ['delivery_id' => (string) $delivery->id, 'outcome' => 'delivered', 'attempts' => (int) $delivery->attempts];
            }

            $boundedOut = (int) $claim['attempts'] >= (int) $claim['max_attempts'];
            if ($result->retryable && ! $boundedOut) {
                $delayMinutes = BackoffPolicy::delayForAttempt((int) $claim['attempts']);
                $delivery->forceFill([
                    'status' => 'failed',
                    'lease_until' => null,
                    'next_run_at' => now()->addMinutes($delayMinutes),
                    'last_error' => $result->error,
                ]);
                $delivery->save();
                $this->audit->record($operator->actorId, 'integrations.delivery.retry_scheduled', 'integration_delivery', $delivery->id, null, [
                    'endpoint' => $claim['endpoint_key'], 'attempts' => $claim['attempts'], 'error' => $result->error,
                    'next_run_at' => $delivery->next_run_at?->toIso8601String(),
                ]);

                return ['delivery_id' => (string) $delivery->id, 'outcome' => 'retry_scheduled', 'attempts' => (int) $delivery->attempts];
            }

            $delivery->forceFill([
                'status' => 'dead_letter',
                'lease_until' => null,
                'next_run_at' => null,
                'last_error' => $result->error,
            ]);
            $delivery->save();
            $this->audit->record($operator->actorId, 'integrations.delivery.dead_letter', 'integration_delivery', $delivery->id, null, [
                'endpoint' => $claim['endpoint_key'],
                'attempts' => $claim['attempts'],
                'reason' => $boundedOut ? 'retry_exhausted' : 'permanent_failure',
                'error' => $result->error,
            ]);

            return ['delivery_id' => (string) $delivery->id, 'outcome' => 'dead_letter', 'attempts' => (int) $delivery->attempts];
        });

        return $final;
    }
}
