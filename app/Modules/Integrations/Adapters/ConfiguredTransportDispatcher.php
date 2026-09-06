<?php

declare(strict_types=1);

namespace App\Modules\Integrations\Adapters;

use App\Modules\Integrations\Domain\Transport;
use App\Modules\Integrations\Domain\TransportResult;

/**
 * Resolves the adapter of a registered endpoint from configuration held
 * outside domain data. An endpoint without a configured transport fails
 * permanently and visibly — an unconfigured integration never fabricates
 * success.
 */
final class ConfiguredTransportDispatcher implements Transport
{
    /** @param  array<string, class-string<Transport>>  $map */
    public function __construct(private readonly array $map = []) {}

    /** @param  array<string, mixed>  $payload */
    public function send(string $endpointKey, string $contractAction, array $payload, string $idempotencyKey, string $correlationId): TransportResult
    {
        $transportClass = $this->map[$endpointKey] ?? null;
        if ($transportClass === null || ! is_a($transportClass, Transport::class, true)) {
            return TransportResult::permanentFailure('integrations.transport_unconfigured');
        }

        /** @var Transport $transport */
        $transport = app($transportClass);

        return $transport->send($endpointKey, $contractAction, $payload, $idempotencyKey, $correlationId);
    }
}
