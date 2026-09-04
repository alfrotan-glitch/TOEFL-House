<?php

declare(strict_types=1);

namespace App\Support\Signing;

/**
 * Server-side integrity signer for Academic eligibility snapshots.
 *
 * The signature is HMAC-SHA256 over the exact canonical JSON bytes that were
 * signed. The key is never stored in domain data: it is derived from
 * `config('app.key')` plus the snapshot contract name, so any app-key rotation
 * invalidates old signatures and fails closed rather than silently accepting
 * an unverifiable snapshot.
 */
final class AcademicEligibilitySigner
{
    public const KEY_VERSION = 'app_key_v1';

    public const ALGORITHM = 'hmac-sha256';

    public const CONTRACT = 'academic-eligibility-snapshot-v1';

    public static function sign(string $canonical): string
    {
        return hash_hmac('sha256', $canonical, self::secret());
    }

    public static function verify(string $canonical, string $signature, string $keyVersion = self::KEY_VERSION): bool
    {
        if ($keyVersion !== self::KEY_VERSION) {
            return false;
        }
        if (strlen($signature) !== 64 || ! ctype_xdigit($signature)) {
            return false;
        }

        return hash_equals(hash_hmac('sha256', $canonical, self::secret()), strtolower($signature));
    }

    /** @param array<string, mixed> $payload */
    public static function verifyPayload(array $payload, string $signature): bool
    {
        return self::verify(CanonicalJson::encode($payload), $signature);
    }

    private static function secret(): string
    {
        $appKey = (string) config('app.key', '');

        return hash_hmac('sha256', self::CONTRACT, $appKey);
    }
}
