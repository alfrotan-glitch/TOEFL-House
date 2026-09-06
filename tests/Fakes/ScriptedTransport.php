<?php

declare(strict_types=1);

namespace Tests\Fakes;

use App\Modules\Integrations\Domain\Transport;
use App\Modules\Integrations\Domain\TransportResult;
use RuntimeException;

/**
 * Deterministic transport double: a scripted sequence of outcomes (or
 * thrown failures) records every send so tests can assert exactly-once
 * delivery.
 */
final class ScriptedTransport implements Transport
{
    /** @var list<TransportResult|RuntimeException> */
    private array $script = [];

    /** @var list<array{action: string, key: string, correlation: string}> */
    private array $sends = [];

    public function send(string $endpointKey, string $contractAction, array $payload, string $idempotencyKey, string $correlationId): TransportResult
    {
        $this->sends[] = ['action' => $contractAction, 'key' => $idempotencyKey, 'correlation' => $correlationId];
        $next = array_shift($this->script);

        if ($next instanceof RuntimeException) {
            throw $next;
        }

        return $next ?? TransportResult::delivered('provider-ref-'.count($this->sends));
    }

    public function willFailTransiently(int $times, string $error = 'integrations.provider_timeout'): self
    {
        for ($i = 0; $i < $times; $i++) {
            $this->script[] = TransportResult::transientFailure($error);
        }

        return $this;
    }

    public function willFailPermanently(string $error = 'integrations.provider_rejected'): self
    {
        $this->script[] = TransportResult::permanentFailure($error);

        return $this;
    }

    public function willThrow(RuntimeException $failure): self
    {
        $this->script[] = $failure;

        return $this;
    }

    /** @return list<array{action: string, key: string, correlation: string}> */
    public function sends(): array
    {
        return $this->sends;
    }

    public function sendCount(): int
    {
        return count($this->sends);
    }
}
