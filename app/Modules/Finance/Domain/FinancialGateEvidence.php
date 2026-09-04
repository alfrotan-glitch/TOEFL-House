<?php

declare(strict_types=1);

namespace App\Modules\Finance\Domain;

use App\Support\Signing\CanonicalJson;

/**
 * Deterministic evidence packaging for the enrollment financial gate.
 *
 * The evidence is canonical JSON with recursively sorted keys, a SHA-256
 * digest, and a server-side HMAC signature over the canonical bytes. The key
 * is derived from `config('app.key')` plus this evidence contract name; it is
 * never stored in domain data, and any app-key rotation fails closed.
 */
final class FinancialGateEvidence
{
    public const SCHEMA_VERSION = 'enrollment-financial-gate-v1';

    public const KEY_VERSION = 'app_key_v1';

    public const ALGORITHM = 'hmac-sha256';

    public const CONTRACT = 'enrollment-financial-gate-v1';

    /** @param array<string, mixed> $evidence
     * @return array{canonical: string, digest: string, signature: string, algorithm: string, key_version: string}
     */
    public static function sign(array $evidence): array
    {
        $canonical = CanonicalJson::encode($evidence);

        return [
            'canonical' => $canonical,
            'digest' => hash('sha256', $canonical),
            'signature' => hash_hmac('sha256', $canonical, self::secret()),
            'algorithm' => self::ALGORITHM,
            'key_version' => self::KEY_VERSION,
        ];
    }

    /** @param array<string, mixed> $evidence */
    public static function verify(array $evidence, string $digest, string $signature): bool
    {
        $canonical = CanonicalJson::encode($evidence);

        return hash_equals(hash('sha256', $canonical), $digest)
            && hash_equals(hash_hmac('sha256', $canonical, self::secret()), $signature);
    }

    private static function secret(): string
    {
        return hash_hmac('sha256', self::CONTRACT, (string) config('app.key', ''));
    }
}
