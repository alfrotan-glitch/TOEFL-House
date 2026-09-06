<?php

declare(strict_types=1);

namespace App\Modules\Integrations\Commands;

use App\Modules\Audit\AttemptedOperation;
use App\Modules\Audit\AuditRecorder;
use App\Modules\Integrations\Models\IntegrationEndpoint;
use App\Support\Authorization\AccessDecision;
use App\Support\Authorization\Actor;
use App\Support\Errors\AuthorizationDenied;
use App\Support\Errors\BusinessRejection;
use App\Support\Idempotency\IdempotentExecution;
use App\Support\Identifiers\RandomIdentifier;
use Illuminate\Support\Facades\DB;

/**
 * Integration boundaries are registered, versioned configuration: one
 * endpoint per key, credentials referenced (never stored), approval
 * required, retirement one-way and history retained.
 */
final class RegisterEndpoint
{
    public const CAPABILITY = 'integrations.endpoint';

    public function __construct(
        private readonly AccessDecision $access,
        private readonly IdempotentExecution $idempotency,
        private readonly AuditRecorder $audit,
        private readonly AttemptedOperation $attemptedOperation,
    ) {}

    /** @return array{endpoint_id: string, correlation_id: string} */
    public function register(Actor $actor, string $key, string $name, string $channel, string $contractVersion, string $credentialRef, string $endpointRef, string $idempotencyKey): array
    {
        $payload = hash('sha256', implode('|', ['integrations.endpoint.register', $key, $name, $channel, $contractVersion, $credentialRef, $endpointRef, $actor->actorId]));

        try {
            return $this->idempotency->execute('integrations.endpoint.register', $idempotencyKey, $payload,
                fn (): array => DB::transaction(function () use ($actor, $key, $name, $channel, $contractVersion, $credentialRef, $endpointRef): array {
                    $this->require($actor);
                    $this->validate($key, $name, $contractVersion, $credentialRef, $endpointRef);
                    if (IntegrationEndpoint::query()->where('key', $key)->exists()) {
                        throw BusinessRejection::forCode('integrations.endpoint_exists', 'this endpoint key is already registered');
                    }

                    $endpoint = IntegrationEndpoint::query()->create([
                        'id' => RandomIdentifier::new(),
                        'key' => $key,
                        'name' => $name,
                        'channel' => $channel,
                        'contract_version' => $contractVersion,
                        'credential_ref' => $credentialRef,
                        'endpoint_ref' => $endpointRef,
                        'state' => 'active',
                        'approved_by' => $actor->actorId,
                        'created_by' => $actor->actorId,
                    ]);
                    $event = $this->audit->record($actor->actorId, 'integrations.endpoint.register', 'integration_endpoint', $endpoint->id, null, ['key' => $key, 'channel' => $channel]);

                    return ['endpoint_id' => $endpoint->id, 'correlation_id' => $event->correlation_id];
                }),
            );
        } catch (AuthorizationDenied $denial) {
            $this->attemptedOperation->deniedByActor($denial, $actor, 'integrations.endpoint.register', 'integration_endpoint', $key);
        }
    }

    /** @return array{endpoint_id: string, correlation_id: string} */
    public function retire(Actor $actor, IntegrationEndpoint $endpoint, string $idempotencyKey): array
    {
        $payload = hash('sha256', implode('|', ['integrations.endpoint.retire', $endpoint->id, $actor->actorId]));

        try {
            return $this->idempotency->execute('integrations.endpoint.retire', $idempotencyKey, $payload,
                fn (): array => DB::transaction(function () use ($actor, $endpoint): array {
                    $this->require($actor);

                    /** @var IntegrationEndpoint $locked */
                    $locked = IntegrationEndpoint::query()->whereKey($endpoint->id)->lockForUpdate()->firstOrFail();
                    if ($locked->state === 'retired') {
                        throw BusinessRejection::forCode('integrations.endpoint_retired', 'this endpoint is already retired');
                    }
                    $locked->forceFill(['state' => 'retired']);
                    $locked->save();
                    $event = $this->audit->record($actor->actorId, 'integrations.endpoint.retire', 'integration_endpoint', $locked->id, null, ['key' => $locked->key]);

                    return ['endpoint_id' => $locked->id, 'correlation_id' => $event->correlation_id];
                }),
            );
        } catch (AuthorizationDenied $denial) {
            $this->attemptedOperation->deniedByActor($denial, $actor, 'integrations.endpoint.retire', 'integration_endpoint', $endpoint->id);
        }
    }

    private function validate(string $key, string $name, string $contractVersion, string $credentialRef, string $endpointRef): void
    {
        if ($key === '' || $name === '' || $endpointRef === '') {
            throw BusinessRejection::forCode('integrations.endpoint_terms', 'an endpoint requires its key, name, and endpoint reference');
        }
        if (! preg_match('/^v\d+$/', $contractVersion)) {
            throw BusinessRejection::forCode('integrations.endpoint_contract', 'the contract version must look like v1, v2, ...');
        }
        if ($credentialRef === '') {
            throw BusinessRejection::forCode('integrations.endpoint_credential', 'an endpoint references its credential store entry; the secret itself never enters domain data');
        }
    }

    private function require(Actor $actor): void
    {
        $outcome = $this->access->decide($actor, self::CAPABILITY, null);
        if (! $outcome->allowed) {
            throw AuthorizationDenied::forCode('integrations.endpoint_denied', $outcome->reason);
        }
    }
}
