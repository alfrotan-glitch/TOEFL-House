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
    /** The signer used by pre-convergence v1 snapshots. */
    public const LEGACY_KEY_VERSION = 'app_key_v1';

    /** The domain-separated signer used by v2 exact-lineage snapshots. */
    public const KEY_VERSION = 'app_key_v2';

    public const ALGORITHM = 'hmac-sha256';

    public const LEGACY_CONTRACT = 'academic-eligibility-snapshot-v1';

    public const CONTRACT = 'academic-eligibility-snapshot-v2';

    public static function sign(string $canonical, string $keyVersion = self::KEY_VERSION): string
    {
        $secret = self::secretFor($keyVersion);
        if ($secret === null) {
            throw new \InvalidArgumentException('unsupported academic eligibility signing key version');
        }

        return hash_hmac('sha256', $canonical, $secret);
    }

    public static function verify(string $canonical, string $signature, string $keyVersion = self::KEY_VERSION): bool
    {
        $secret = self::secretFor($keyVersion);
        if ($secret === null || strlen($signature) !== 64 || ! ctype_xdigit($signature)) {
            return false;
        }

        return hash_equals(hash_hmac('sha256', $canonical, $secret), strtolower($signature));
    }

    /** @param array<string, mixed> $payload */
    public static function verifyPayload(array $payload, string $signature, string $keyVersion = self::KEY_VERSION): bool
    {
        return self::verify(CanonicalJson::encode($payload), $signature, $keyVersion);
    }

    private static function secretFor(string $keyVersion): ?string
    {
        $contract = match ($keyVersion) {
            self::LEGACY_KEY_VERSION => self::LEGACY_CONTRACT,
            self::KEY_VERSION => self::CONTRACT,
            default => null,
        };
        if ($contract === null) {
            return null;
        }

        return hash_hmac('sha256', $contract, (string) config('app.key', ''));
    }
}
