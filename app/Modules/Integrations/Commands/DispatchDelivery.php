<?php

declare(strict_types=1);

namespace App\Modules\Integrations\Commands;

use App\Modules\Audit\AttemptedOperation;
use App\Modules\Audit\AuditRecorder;
use App\Modules\Integrations\Models\IntegrationDelivery;
use App\Modules\Integrations\Models\IntegrationEndpoint;
use App\Support\Authorization\AccessDecision;
use App\Support\Authorization\Actor;
use App\Support\Errors\AuthorizationDenied;
use App\Support\Errors\BusinessRejection;
use App\Support\Idempotency\IdempotentExecution;
use App\Support\Identifiers\RandomIdentifier;
use Illuminate\Support\Facades\DB;

/**
 * Outbound outbox entry: source-linked, idempotent per (endpoint, key),
 * payload digested for tamper evidence. The delivery starts queued; the
 * external send happens only in the processing core.
 */
final class DispatchDelivery
{
    public const CAPABILITY = 'integrations.dispatch';

    public function __construct(
        private readonly AccessDecision $access,
        private readonly IdempotentExecution $idempotency,
        private readonly AuditRecorder $audit,
        private readonly AttemptedOperation $attemptedOperation,
    ) {}

    /** @param  array<string, mixed>  $payload
     * @return array{delivery_id: string, status: string, duplicate: bool, correlation_id: string} */
    public function dispatch(Actor $actor, string $endpointKey, string $idempotencyKey, string $sourceType, string $sourceId, string $contractAction, array $payload, string $key): array
    {
        $digest = hash('sha256', json_encode($payload) ?: '');
        $hash = hash('sha256', implode('|', ['integrations.delivery.dispatch', $endpointKey, $idempotencyKey, $sourceType, $sourceId, $contractAction, $digest, $actor->actorId]));

        try {
            return $this->idempotency->execute('integrations.delivery.dispatch', $key, $hash,
                fn (): array => DB::transaction(function () use ($actor, $endpointKey, $idempotencyKey, $sourceType, $sourceId, $contractAction, $payload, $digest): array {
                    $this->require($actor);

                    /** @var IntegrationEndpoint $endpoint */
                    $endpoint = IntegrationEndpoint::query()->where('key', $endpointKey)->firstOrFail();
                    if ($endpoint->state !== 'active') {
                        throw BusinessRejection::forCode('integrations.endpoint_inactive', 'deliveries may only be dispatched to an active endpoint');
                    }
                    if ($contractAction === '' || $payload === []) {
                        throw BusinessRejection::forCode('integrations.delivery_contract', 'a delivery carries a contract action and a non-empty payload');
                    }

                    /** @var IntegrationDelivery|null $existing */
                    $existing = IntegrationDelivery::query()->where('endpoint_id', $endpoint->id)->where('idempotency_key', $idempotencyKey)->lockForUpdate()->first();
                    if ($existing !== null) {
                        // duplicate delivery is safe: the original outbox entry answers
                        return ['delivery_id' => $existing->id, 'status' => $existing->status, 'duplicate' => true, 'correlation_id' => $existing->correlation_id];
                    }

                    $delivery = IntegrationDelivery::query()->create([
                        'id' => RandomIdentifier::new(),
                        'endpoint_id' => $endpoint->id,
                        'idempotency_key' => $idempotencyKey,
                        'correlation_id' => RandomIdentifier::new(),
                        'source_type' => $sourceType,
                        'source_id' => $sourceId,
                        'contract_action' => $contractAction,
                        'payload' => $payload,
                        'payload_digest' => $digest,
                        'status' => 'queued',
                        'attempts' => 0,
                        'max_attempts' => 5,
                        'requeues' => 0,
                        'next_run_at' => null,
                        'created_by' => $actor->actorId,
                    ]);
                    $event = $this->audit->record($actor->actorId, 'integrations.delivery.dispatch', 'integration_delivery', $delivery->id, null, [
                        'endpoint' => $endpoint->key, 'action' => $contractAction, 'digest' => $digest,
                    ]);

                    return ['delivery_id' => $delivery->id, 'status' => 'queued', 'duplicate' => false, 'correlation_id' => $event->correlation_id];
                }),
            );
        } catch (AuthorizationDenied $denial) {
            $this->attemptedOperation->deniedByActor($denial, $actor, 'integrations.delivery.dispatch', 'integration_delivery', $endpointKey);
        }
    }

    private function require(Actor $actor): void
    {
        $outcome = $this->access->decide($actor, self::CAPABILITY, null);
        if (! $outcome->allowed) {
            throw AuthorizationDenied::forCode('integrations.dispatch_denied', $outcome->reason);
        }
    }
}
