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
    public static function positive(string $amount): bool
    {
        return self::valid($amount) && bccomp($amount, '0.00', 2) === 1;
    }

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

    public static function valid(string $amount, bool $signed = false): bool
    {
        $pattern = $signed
            ? '/^-?\d{1,12}(\.\d{1,2})?$/'
            : '/^\d{1,12}(\.\d{1,2})?$/';

        return preg_match($pattern, $amount) === 1;
    }
}
