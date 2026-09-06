<?php

declare(strict_types=1);

namespace App\Support\Signing;

use RuntimeException;

/**
 * Deterministic JSON canonicalization for integrity-signed domain objects.
 *
 * Associative arrays are recursively key-sorted (string keys); sequential
 * lists keep their order. Strings use JSON_UNESCAPED_SLASHES and
 * JSON_UNESCAPED_UNICODE so the same logical object always produces the same
 * byte string regardless of JSON key order.
 */
final class CanonicalJson
{
    /**
     * @throws RuntimeException when the value cannot be represented
     *                          deterministically as JSON.
     */
    public static function encode(mixed $value): string
    {
        if (is_array($value)) {
            if (array_is_list($value)) {
                $parts = array_map(static fn (mixed $v): string => self::encode($v), $value);

                return '['.implode(',', $parts).']';
            }

            ksort($value, SORT_STRING);
            $parts = [];
            foreach ($value as $key => $item) {
                $parts[] = self::encodeString((string) $key).':'.self::encode($item);
            }

            return '{'.implode(',', $parts).'}';
        }

        if ($value === null || is_bool($value) || is_int($value) || is_float($value)) {
            return self::encodeScalar($value);
        }

        if (is_string($value)) {
            return self::encodeString($value);
        }

        if ($value instanceof \JsonSerializable) {
            return self::encode($value->jsonSerialize());
        }

        if ($value instanceof \Stringable) {
            return self::encodeString((string) $value);
        }

        if (is_object($value)) {
            return self::encode(self::objectToArray($value));
        }

        throw new RuntimeException(sprintf('cannot canonicalize value of type %s', get_debug_type($value)));
    }

    private static function encodeString(string $value): string
    {
        return json_encode($value, JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE | JSON_THROW_ON_ERROR);
    }

    private static function encodeScalar(bool|int|float|null $value): string
    {
        return json_encode(
            $value,
            JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE | JSON_PRESERVE_ZERO_FRACTION | JSON_THROW_ON_ERROR,
        );
    }

    /** @return array<string, mixed> */
    private static function objectToArray(object $value): array
    {
        $reflection = new \ReflectionObject($value);
        $result = [];
        foreach (get_object_vars($value) as $name => $item) {
            $result[$name] = $item;
        }
        foreach ($reflection->getProperties() as $property) {
            if ($property->isInitialized($value) && ! array_key_exists($property->getName(), $result)) {
                $result[$property->getName()] = $property->getValue($value);
            }
        }

        return $result;
    }
}
