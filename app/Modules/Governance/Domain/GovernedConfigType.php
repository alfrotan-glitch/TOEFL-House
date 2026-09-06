<?php

declare(strict_types=1);

namespace App\Modules\Governance\Domain;

use App\Support\Errors\ValidationError;

/**
 * The ratified value types a governed_config may hold (WP-2 S1). Type = the
 * shape/constraint of the scalar value; semantics live in the config_key's
 * ratified definition. Value is a typed envelope {"v": <scalar>} in storage,
 * so a governed config is never an untyped free-form JSON authority.
 *
 * Money values are whole minor units of the operating currency; percent is a
 * whole 0..100; integers are whole non-negative (or positive) counts; an
 * approver_reference is a non-empty person identifier used by approval-routing
 * governed configuration.
 */
final class GovernedConfigType
{
    public const NONNEGATIVE_MONEY = 'nonnegative_money';

    public const POSITIVE_MONEY = 'positive_money';

    public const NONNEGATIVE_INTEGER = 'nonnegative_integer';

    public const POSITIVE_INTEGER = 'positive_integer';

    public const PERCENT = 'percent';

    public const APPROVER_REFERENCE = 'approver_reference';

    /** @var list<string> */
    private const NUMERIC_TYPES = [
        self::NONNEGATIVE_MONEY,
        self::POSITIVE_MONEY,
        self::NONNEGATIVE_INTEGER,
        self::POSITIVE_INTEGER,
        self::PERCENT,
    ];

    /** @return list<string> */
    public static function all(): array
    {
        return [
            self::NONNEGATIVE_MONEY,
            self::POSITIVE_MONEY,
            self::NONNEGATIVE_INTEGER,
            self::POSITIVE_INTEGER,
            self::PERCENT,
            self::APPROVER_REFERENCE,
        ];
    }

    public static function isKnown(string $type): bool
    {
        return in_array($type, self::all(), true);
    }

    public static function isNumeric(string $type): bool
    {
        return in_array($type, self::NUMERIC_TYPES, true);
    }

    /** @return list<string> */
    public static function numericTypes(): array
    {
        return self::NUMERIC_TYPES;
    }

    /**
     * Authoritative domain validation of a scalar against a config type.
     * Rejects unknown types and values that violate the declared constraints.
     */
    public static function assertValue(string $type, mixed $value): void
    {
        if (! self::isKnown($type)) {
            throw ValidationError::forCode('governance.config_type_unknown', sprintf('unsupported governed config type "%s"', $type));
        }

        if (self::isNumeric($type)) {
            if (! is_int($value)) {
                throw ValidationError::forCode('governance.invalid_value', sprintf('governed config type %s requires an integer value', $type));
            }

            if ($type === self::POSITIVE_MONEY || $type === self::POSITIVE_INTEGER) {
                if ($value < 1) {
                    throw ValidationError::forCode('governance.invalid_value', sprintf('governed config type %s requires a positive value', $type));
                }
            } elseif ($value < 0) {
                throw ValidationError::forCode('governance.invalid_value', sprintf('governed config type %s requires a non-negative value', $type));
            }

            if ($type === self::PERCENT && $value > 100) {
                throw ValidationError::forCode('governance.invalid_value', 'governed config type percent requires a value between 0 and 100');
            }

            return;
        }

        if ($type === self::APPROVER_REFERENCE) {
            if (! is_string($value) || trim($value) === '') {
                throw ValidationError::forCode('governance.invalid_value', 'governed config type approver_reference requires a non-empty string');
            }

            return;
        }
    }
}
