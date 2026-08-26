<?php

declare(strict_types=1);

namespace App\Modules\Integrations\Commands;

use App\Modules\Audit\AttemptedOperation;
use App\Modules\Audit\AuditRecorder;
use App\Modules\Integrations\Domain\SignatureVerifier;
use App\Modules\Integrations\Models\InboundEvent;
use App\Modules\Integrations\Models\IntegrationEndpoint;
use App\Support\Authorization\AccessDecision;
use App\Support\Authorization\Actor;
use App\Support\Errors\AuthorizationDenied;
use App\Support\Errors\BusinessRejection;
use App\Support\Idempotency\IdempotentExecution;
use App\Support\Identifiers\RandomIdentifier;
use Illuminate\Support\Facades\DB;

/**
 * Webhook intake: the endpoint must be registered and active, the payload
 * well-formed, and the signature verified against the endpoint's secret
 * (held outside domain data). Accepted events deduplicate per (endpoint,
 * external id) — repeated delivery returns the original; rejected
 * evidence is retained without blocking a corrected retry.
 */
final class ReceiveInbound
{
    public const CAPABILITY = 'integrations.inbound';

    public function __construct(
        private readonly AccessDecision $access,
        private readonly IdempotentExecution $idempotency,
        private readonly AuditRecorder $audit,
        private readonly AttemptedOperation $attemptedOperation,
        private readonly SignatureVerifier $verifier,
    ) {}

    /** @param  array<string, mixed>|null  $payload
     * @return array{event_id: string, status: string, duplicate: bool} */
    public function receive(Actor $actor, string $endpointKey, string $externalId, string $eventType, ?array $payload, string $signature, string $idempotencyKey): array
    {
        $digest = hash('sha256', json_encode($payload) ?: 'null');
        $hash = hash('sha256', implode('|', ['integrations.inbound.receive', $endpointKey, $externalId, $eventType, $digest, $actor->actorId]));

        try {
            return $this->idempotency->execute('integrations.inbound.receive', $idempotencyKey, $hash,
                fn (): array => DB::transaction(function () use ($actor, $endpointKey, $externalId, $eventType, $payload, $signature, $digest): array {
                    $this->require($actor);

                    /** @var IntegrationEndpoint $endpoint */
                    $endpoint = IntegrationEndpoint::query()->where('key', $endpointKey)->firstOrFail();
                    if ($endpoint->state !== 'active') {
                        throw BusinessRejection::forCode('integrations.endpoint_inactive', 'inbound events are accepted only for an active endpoint');
                    }

                    $rejected = fn (string $code, string $error): array => $this->retainRejection($actor, $endpoint->id, $externalId, $eventType, $payload ?? [], $digest, $code, $error);

                    if ($externalId === '' || $eventType === '' || $payload === null || $payload === []) {
                        return $rejected('integrations.payload', 'a webhook carries its external id, event type, and a non-empty payload');
                    }
                    if (! $this->verifier->verify($endpointKey, $digest, $signature)) {
                        return $rejected('integrations.signature', 'the webhook signature does not verify for this endpoint');
                    }

                    /** @var InboundEvent|null $existing */
                    $existing = InboundEvent::query()->where('endpoint_id', $endpoint->id)->where('external_id', $externalId)->whereIn('status', ['received', 'processed', 'duplicate'])->lockForUpdate()->first();
                    if ($existing !== null) {
                        // duplicate delivery: the accepted original answers, never reprocessed
                        return ['event_id' => $existing->id, 'status' => $existing->status, 'duplicate' => true];
                    }

                    $event = InboundEvent::query()->create([
                        'id' => RandomIdentifier::new(),
                        'endpoint_id' => $endpoint->id,
                        'external_id' => $externalId,
                        'event_type' => $eventType,
                        'payload' => $payload,
                        'payload_digest' => $digest,
                        'signature_verified' => true,
                        'status' => 'received',
                        'received_by' => $actor->actorId,
                    ]);
                    $this->audit->record($actor->actorId, 'integrations.inbound.receive', 'inbound_event', $event->id, null, ['endpoint' => $endpointKey, 'external_id' => $externalId]);

                    return ['event_id' => $event->id, 'status' => 'received', 'duplicate' => false];
                }),
            );
        } catch (AuthorizationDenied $denial) {
            $this->attemptedOperation->deniedByActor($denial, $actor, 'integrations.inbound.receive', 'inbound_event', $endpointKey);
        }
    }

    /** @param  array<string, mixed>  $payload
     * @return array{event_id: string, status: string, duplicate: bool} */
    private function retainRejection(Actor $actor, string $endpointId, string $externalId, string $eventType, array $payload, string $digest, string $code, string $error): array
    {
        $event = InboundEvent::query()->create([
            'id' => RandomIdentifier::new(),
            'endpoint_id' => $endpointId,
            'external_id' => $externalId === '' ? 'unknown' : $externalId,
            'event_type' => $eventType === '' ? 'unknown' : $eventType,
            'payload' => $payload,
            'payload_digest' => $digest,
            'signature_verified' => false,
            'status' => 'rejected',
            'error' => $code.': '.$error,
            'received_by' => $actor->actorId,
        ]);
        $this->audit->record($actor->actorId, 'integrations.inbound.rejected', 'inbound_event', $event->id, null, ['code' => $code]);

        return ['event_id' => $event->id, 'status' => 'rejected', 'duplicate' => false];
    }

    private function require(Actor $actor): void
    {
        $outcome = $this->access->decide($actor, self::CAPABILITY, null);
        if (! $outcome->allowed) {
            throw AuthorizationDenied::forCode('integrations.inbound_denied', $outcome->reason);
        }
    }
}
