<?php

declare(strict_types=1);

namespace App\Support;

/**
 * Boundary representation for ordinary two-decimal money. Monetary commands
 * must not use binary floating-point comparisons: a value that is accepted
 * here is the same fixed-point shape the decimal(14,2) database columns and
 * the HTTP `money` validation rule represent.
 */
final class MoneyAmount
{
    /**
     * Normalizes an already-validated decimal money value (DB decimal column
     * or validated input) into numeric-string, or fails closed on anything
     * that is not the fixed two-decimal-or-integer shape this boundary
     * accepts. Prevents raw DB aggregates from silently entering bcmath.
     *
     * @return numeric-string
     */
    public static function decimal(mixed $value): string
    {
        $amount = is_int($value) ? (string) $value : (is_string($value) ? $value : null);
        if ($amount === null || ! self::valid($amount)) {
            throw new \InvalidArgumentException('money value is not a valid decimal');
        }

        return $amount;
    }

    /**
     * @phpstan-assert-if-true numeric-string $amount
     */
    public static function positive(string $amount): bool
    {
        return self::valid($amount) && bccomp($amount, '0.00', 2) === 1;
    }

    /**
     * @phpstan-assert-if-true numeric-string $amount
     */
    public static function nonNegative(string $amount): bool
    {
        return self::valid($amount) && bccomp($amount, '0.00', 2) !== -1;
    }

    public static function signed(string $amount): bool
    {
        if (! self::valid($amount, true)) {
            return false;
        }

        return ! str_starts_with($amount, '-') || bccomp($amount, '0.00', 2) !== 0;
    }

    /**
     * @phpstan-assert-if-true numeric-string $amount
     */
    public static function valid(string $amount, bool $signed = false): bool
    {
        $pattern = $signed
            ? '/^-?\d{1,12}(\.\d{1,2})?$/'
            : '/^\d{1,12}(\.\d{1,2})?$/';

        return preg_match($pattern, $amount) === 1;
    }
}
