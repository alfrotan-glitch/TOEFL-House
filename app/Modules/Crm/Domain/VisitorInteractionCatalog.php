<?php

declare(strict_types=1);

namespace App\Modules\Crm\Domain;

/** Canonical interaction vocabulary shared by commands, traces, and schema. */
final class VisitorInteractionCatalog
{
    /** @var list<string> */
    private const DIRECTIONS = ['inbound', 'outbound'];

    /** @var list<string> */
    private const TYPES = [
        'call', 'whatsapp', 'email', 'sms', 'visit', 'meeting', 'form_submission',
        'document', 'note', 'other', 'payment', 'assessment', 'placement',
    ];

    /** @var list<string> */
    private const OUTCOMES = [
        'no_answer', 'connected', 'positive', 'neutral', 'negative', 'unreachable',
        'requested_info', 'scheduled_visit', 'followup_required', 'not_interested',
        'qualified', 'converted', 'other',
    ];

    /** @return list<string> */
    public static function directions(): array
    {
        return self::DIRECTIONS;
    }

    /** @return list<string> */
    public static function types(): array
    {
        return self::TYPES;
    }

    /** @return list<string> */
    public static function outcomes(): array
    {
        return self::OUTCOMES;
    }

    public static function isDirection(string $value): bool
    {
        return in_array($value, self::DIRECTIONS, true);
    }

    public static function isType(string $value): bool
    {
        return in_array($value, self::TYPES, true);
    }

    public static function isOutcome(string $value): bool
    {
        return in_array($value, self::OUTCOMES, true);
    }
}
