<?php

declare(strict_types=1);

namespace App\Modules\Academic\Placement\Domain;

use App\Modules\Academic\Placement\Models\PlacementAttempt;

/**
 * Server-side evidence integrity: an HMAC over the canonical submitted
 * evidence payload. The key is derived from the per-attempt provenance so
 * the hash is untamperable by a candidate who only sees the question set.
 */
final class PlacementAntiTamper
{
    /** @param  array<string, string>  $answers */
    public static function evidencePayload(array $answers, ?string $evidenceRef, int $durationSeconds): string
    {
        $normalized = [];
        foreach ($answers as $questionId => $value) {
            $normalized[] = $questionId.'='.hash('sha256', (string) $value);
        }
        sort($normalized, SORT_STRING);
        $body = implode('|', $normalized).'|ref='.hash('sha256', (string) $evidenceRef).'|duration='.$durationSeconds;

        return $body;
    }

    /** @param  array<string, string>  $answers */
    public static function hmac(PlacementAttempt $attempt, array $answers, ?string $evidenceRef, int $durationSeconds): string
    {
        $key = self::key($attempt);

        return hash_hmac('sha256', self::evidencePayload($answers, $evidenceRef, $durationSeconds), $key);
    }

    /** @param  array<string, string>  $answers */
    public static function verify(PlacementAttempt $attempt, array $answers, ?string $evidenceRef, int $durationSeconds, string $expectedHmac): bool
    {
        return hash_equals($expectedHmac, self::hmac($attempt, $answers, $evidenceRef, $durationSeconds));
    }

    public static function key(PlacementAttempt $attempt): string
    {
        // Deterministic from the server-side record, not transmittable.
        return hash('sha256', implode('|', [
            $attempt->id, $attempt->profile_id, $attempt->test_version_id,
            (string) $attempt->originating_branch_id, config('app.key'),
        ]));
    }
}
