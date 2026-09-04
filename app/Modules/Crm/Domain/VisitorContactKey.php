<?php

declare(strict_types=1);

namespace App\Modules\Crm\Domain;

/**
 * Normalized primary contact key for anti-duplicate control. Email is the
 * primary key when present; a phone number is the fallback. Non-alphanumeric
 * phone characters are stripped so +93 ... and 93 ... deduplicate.
 */
final class VisitorContactKey
{
    public static function of(?string $email, ?string $phone): string
    {
        $emailKey = strtolower(trim((string) $email));
        if ($emailKey !== '') {
            return $emailKey;
        }

        return preg_replace('/[^0-9]/', '', trim((string) $phone)) ?? '';
    }
}
