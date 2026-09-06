<?php

declare(strict_types=1);

namespace App\Modules\Integrations\Domain;

/**
 * Anti-corruption adapter outcome: a delivery either carries the external
 * system's reference, or it failed — transiently (retry) or permanently
 * (manual review). Success is never fabricated.
 */
final class TransportResult
{
    private function __construct(
        public readonly bool $delivered,
        public readonly ?string $reference,
        public readonly bool $retryable,
        public readonly ?string $error,
    ) {}

    public static function delivered(string $reference): self
    {
        return new self(true, $reference, false, null);
    }

    public static function transientFailure(string $error): self
    {
        return new self(false, null, true, $error);
    }

    public static function permanentFailure(string $error): self
    {
        return new self(false, null, false, $error);
    }
}
