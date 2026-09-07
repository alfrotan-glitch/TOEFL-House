<?php

declare(strict_types=1);

namespace App\Modules\Finance\Domain;

use App\Support\MoneyAmount;
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

    /**
     * Accept only the signed part of a Finance assessment at a consuming
     * boundary. The convenience fields returned alongside evidence are a
     * transport envelope, not a second source of financial truth: callers
     * must never persist or audit them without deriving them back from the
     * HMAC-protected evidence.
     *
     * @param array<string, mixed> $assessment
     * @return array{evidence: array<string, mixed>, digest: string, signature: string, satisfied: bool, uncovered: numeric-string, remaining: numeric-string, assessed_at: string}|null
     */
    public static function verifiedAssessment(array $assessment): ?array
    {
        $evidence = $assessment['evidence'] ?? null;
        $digest = $assessment['digest'] ?? null;
        $signature = $assessment['signature'] ?? null;
        if (! is_array($evidence) || ! is_string($digest) || ! is_string($signature)) {
            return null;
        }

        try {
            if (! self::verify($evidence, $digest, $signature)) {
                return null;
            }
        } catch (\Throwable) {
            // Canonicalization must be total at this trust boundary: malformed
            // adapter data is invalid evidence, never an application failure.
            return null;
        }

        $satisfied = $evidence['satisfied'] ?? null;
        $assessedAt = $evidence['assessed_at'] ?? null;
        if (($evidence['schema_version'] ?? null) !== self::SCHEMA_VERSION
            || ! is_bool($satisfied)
            || ! is_string($assessedAt)
            || trim($assessedAt) === '') {
            return null;
        }

        try {
            $uncovered = MoneyAmount::decimal($evidence['uncovered'] ?? null);
            $remaining = MoneyAmount::decimal($evidence['remaining'] ?? null);
        } catch (\InvalidArgumentException) {
            return null;
        }
        if (! MoneyAmount::nonNegative($uncovered) || ! MoneyAmount::nonNegative($remaining)
            || ! self::coverageCommitmentsAreWellFormed($evidence)) {
            return null;
        }

        return [
            'evidence' => $evidence,
            'digest' => $digest,
            'signature' => $signature,
            'satisfied' => $satisfied,
            'uncovered' => $uncovered,
            'remaining' => $remaining,
            'assessed_at' => $assessedAt,
        ];
    }

    /**
     * Newer gate assessments include attributed coverage commitments. Treat
     * the field as an optional extension so verified historical v1 evidence
     * remains readable, but require every new entry to reconcile exactly to
     * the signed source-category totals. A signed malformed extension is not
     * acceptable enrollment evidence.
     *
     * @param array<string, mixed> $evidence
     */
    private static function coverageCommitmentsAreWellFormed(array $evidence): bool
    {
        if (! array_key_exists('coverage_commitments', $evidence)) {
            return true;
        }
        $coverage = $evidence['coverage'] ?? null;
        $commitments = $evidence['coverage_commitments'];
        if (! is_array($coverage) || ! is_array($commitments)) {
            return false;
        }

        $categoryBySource = [
            'financial_credit' => 'credit',
            'enrollment_installment_plan' => 'installment',
            'financial_gate_exception' => 'exception',
        ];
        /** @var array<string, numeric-string> $totals */
        $totals = ['credit' => '0.00', 'installment' => '0.00', 'exception' => '0.00'];
        foreach ($commitments as $commitment) {
            if (! is_array($commitment)) {
                return false;
            }
            $sourceType = $commitment['source_type'] ?? null;
            $sourceId = $commitment['source_id'] ?? null;
            $obligationId = $commitment['obligation_id'] ?? null;
            $commitmentId = $commitment['commitment_id'] ?? null;
            if (! is_string($sourceType) || ! array_key_exists($sourceType, $categoryBySource)
                || ! is_string($sourceId) || trim($sourceId) === ''
                || ! is_string($obligationId) || trim($obligationId) === ''
                || ! is_string($commitmentId) || trim($commitmentId) === '') {
                return false;
            }
            try {
                $amount = MoneyAmount::decimal($commitment['amount'] ?? null);
            } catch (\InvalidArgumentException) {
                return false;
            }
            if (! MoneyAmount::positive($amount)) {
                return false;
            }
            $category = $categoryBySource[$sourceType];
            $totals[$category] = bcadd($totals[$category], $amount, 2);
        }

        foreach ($totals as $category => $total) {
            try {
                $signedTotal = MoneyAmount::decimal($coverage[$category] ?? null);
            } catch (\InvalidArgumentException) {
                return false;
            }
            if (! MoneyAmount::nonNegative($signedTotal) || bccomp($signedTotal, $total, 2) !== 0) {
                return false;
            }
        }

        return true;
    }

    private static function secret(): string
    {
        return hash_hmac('sha256', self::CONTRACT, (string) config('app.key', ''));
    }
}
