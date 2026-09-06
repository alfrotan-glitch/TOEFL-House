<?php

declare(strict_types=1);

namespace App\Modules\Finance\Domain;

use App\Support\Errors\BusinessRejection;

/**
 * Discount lifecycle (foundation 32/34): a discount is proposed with its
 * eligibility and effective dates, then approved by a different actor;
 * approved discounts are immutable and the original charge is preserved.
 */
final class PaymentLifecycle
{
    public const DISCOUNT_PROPOSED = 'proposed';

    public const DISCOUNT_APPROVED = 'approved';

    private const DISCOUNT_TRANSITIONS = [
        self::DISCOUNT_PROPOSED => [self::DISCOUNT_APPROVED],
        self::DISCOUNT_APPROVED => [],
    ];

    public static function allowsDiscountTransition(string $from, string $to): bool
    {
        return in_array($to, self::DISCOUNT_TRANSITIONS[$from] ?? [], true);
    }

    public static function requireDiscountTransition(string $from, string $to): void
    {
        if (! self::allowsDiscountTransition($from, $to)) {
            throw BusinessRejection::forCode('finance.discount_transition_forbidden', sprintf('discount cannot move from %s to %s', $from, $to));
        }
    }
}
