<?php

declare(strict_types=1);

namespace App\Modules\Integrations\Domain;

use App\Modules\Audit\AuditRecorder;
use App\Modules\Integrations\Models\IntegrationDelivery;
use App\Modules\Integrations\Models\IntegrationEndpoint;
use App\Support\Authorization\Actor;
use Illuminate\Support\Facades\DB;

/**
 * The single transactional core for outbound deliveries (used by both the
 * interactive command and the scheduled retry sweep — one behavior, no
 * parallel infrastructure). Claims a due delivery row under lock, so a
 * concurrent worker finds it terminal or not-yet-due and skips; bounded
 * retries with exponential backoff; exhaustion dead-letters visibly.
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
        return DB::transaction(function () use ($deliveryId, $operator): array {
            /** @var IntegrationDelivery|null $delivery */
            $delivery = IntegrationDelivery::query()->whereKey($deliveryId)->lockForUpdate()->first();
            if ($delivery === null) {
                return ['delivery_id' => $deliveryId, 'outcome' => 'skipped_missing', 'attempts' => 0];
            }

            return $this->attempt($delivery, $operator);
        });
    }

    /** @return array{delivery_id: string, outcome: string, attempts: int} */
    public function attempt(IntegrationDelivery $delivery, Actor $operator): array
    {
        // already terminal — replay safe, no duplicate send
        if ($delivery->status === 'delivered' || $delivery->status === 'dead_letter') {
            return ['delivery_id' => $delivery->id, 'outcome' => 'skipped_terminal', 'attempts' => $delivery->attempts];
        }

        // backoff window not elapsed — a concurrent or premature worker skips
        if ($delivery->next_run_at !== null && $delivery->next_run_at->isFuture()) {
            return ['delivery_id' => $delivery->id, 'outcome' => 'skipped_not_due', 'attempts' => $delivery->attempts];
        }

        /** @var IntegrationEndpoint $endpoint */
        $endpoint = IntegrationEndpoint::query()->findOrFail($delivery->endpoint_id);
        $attempts = $delivery->attempts + 1;
        $result = $this->transport->send($endpoint->key, $delivery->contract_action, $delivery->payload ?? [], $delivery->idempotency_key, $delivery->correlation_id);

        if ($result->delivered) {
            $delivery->forceFill([
                'status' => 'delivered',
                'attempts' => $attempts,
                'next_run_at' => null,
                'last_error' => null,
                'delivered_ref' => $result->reference,
                'delivered_at' => now(),
            ]);
            $delivery->save();
            $this->audit->record($operator->actorId, 'integrations.delivery.delivered', 'integration_delivery', $delivery->id, null, [
                'endpoint' => $endpoint->key, 'attempts' => $attempts, 'reference' => $result->reference,
            ]);

            return ['delivery_id' => $delivery->id, 'outcome' => 'delivered', 'attempts' => $attempts];
        }

        $boundedOut = $attempts >= $delivery->max_attempts;
        if ($result->retryable && ! $boundedOut) {
            $delayMinutes = BackoffPolicy::delayForAttempt($attempts);
            $delivery->forceFill([
                'status' => 'failed',
                'attempts' => $attempts,
                'next_run_at' => now()->addMinutes($delayMinutes),
                'last_error' => $result->error,
            ]);
            $delivery->save();

            return ['delivery_id' => $delivery->id, 'outcome' => 'retry_scheduled', 'attempts' => $attempts];
        }

        $delivery->forceFill([
            'status' => 'dead_letter',
            'attempts' => $attempts,
            'next_run_at' => null,
            'last_error' => $result->error,
        ]);
        $delivery->save();
        $this->audit->record($operator->actorId, 'integrations.delivery.dead_letter', 'integration_delivery', $delivery->id, null, [
            'endpoint' => $endpoint->key, 'attempts' => $attempts, 'reason' => $boundedOut ? 'retry_exhausted' : 'permanent_failure', 'error' => $result->error,
        ]);

        return ['delivery_id' => $delivery->id, 'outcome' => 'dead_letter', 'attempts' => $attempts];
    }
}
