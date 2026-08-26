<?php

declare(strict_types=1);

namespace App\Modules\Integrations\Domain;

/**
 * The adapter boundary to one external system. Credentials live outside
 * domain data; the transport maps the canonical contract action and
 * payload, and answers with a correlation-safe, idempotent result.
 */
interface Transport
{
    /** @param  array<string, mixed>  $payload */
    public function send(string $endpointKey, string $contractAction, array $payload, string $idempotencyKey, string $correlationId): TransportResult;
}
