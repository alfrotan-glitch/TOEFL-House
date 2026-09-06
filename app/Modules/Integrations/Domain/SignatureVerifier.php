<?php

declare(strict_types=1);

namespace App\Modules\Integrations\Domain;

/**
 * Webhook authentication: HMAC-SHA256 over the payload digest with the
 * endpoint's secret held outside domain data (configuration, never a
 * domain column).
 */
final class SignatureVerifier
{
    /** @param  array<string, string>  $secrets */
    public function __construct(private readonly array $secrets = []) {}

    public function verify(string $endpointKey, string $payloadDigest, string $providedSignature): bool
    {
        $secret = $this->secrets[$endpointKey] ?? null;
        if ($secret === null || $secret === '' || $providedSignature === '') {
            return false;
        }

        return hash_equals(hash_hmac('sha256', $payloadDigest, $secret), $providedSignature);
    }
}
