<?php

declare(strict_types=1);

namespace App\Modules\Crm\Domain;

use App\Modules\Crm\Models\Visitor;
use App\Support\Errors\BusinessRejection;

/**
 * Visitor pipeline state machine. A lead can move forward/back within the
 * pipeline while it stays open; converted/lost/archived are terminal (lost may
 * be revived to contacted as a deliberate re-engagement, which is audited).
 */
final class VisitorStatus
{
    /** @return list<string> */
    public static function states(): array
    {
        return [
            Visitor::STATUS_NEW,
            Visitor::STATUS_CONTACTED,
            Visitor::STATUS_ENGAGED,
            Visitor::STATUS_QUALIFIED,
            Visitor::STATUS_UNQUALIFIED,
            Visitor::STATUS_CONVERTED,
            Visitor::STATUS_LOST,
            Visitor::STATUS_ARCHIVED,
        ];
    }

    /** @return array<string, list<string>> */
    private static function transitions(): array
    {
        return [
            Visitor::STATUS_NEW => [
                Visitor::STATUS_CONTACTED, Visitor::STATUS_ENGAGED, Visitor::STATUS_QUALIFIED,
                Visitor::STATUS_UNQUALIFIED, Visitor::STATUS_LOST, Visitor::STATUS_CONVERTED,
            ],
            Visitor::STATUS_CONTACTED => [
                Visitor::STATUS_ENGAGED, Visitor::STATUS_QUALIFIED, Visitor::STATUS_UNQUALIFIED,
                Visitor::STATUS_LOST, Visitor::STATUS_CONVERTED,
            ],
            Visitor::STATUS_ENGAGED => [
                Visitor::STATUS_QUALIFIED, Visitor::STATUS_UNQUALIFIED,
                Visitor::STATUS_LOST, Visitor::STATUS_CONVERTED,
            ],
            Visitor::STATUS_QUALIFIED => [
                Visitor::STATUS_CONVERTED, Visitor::STATUS_UNQUALIFIED, Visitor::STATUS_LOST,
            ],
            Visitor::STATUS_UNQUALIFIED => [
                Visitor::STATUS_ENGAGED, Visitor::STATUS_QUALIFIED,
                Visitor::STATUS_LOST, Visitor::STATUS_CONVERTED, Visitor::STATUS_ARCHIVED,
            ],
            Visitor::STATUS_CONVERTED => [],
            Visitor::STATUS_LOST => [Visitor::STATUS_CONTACTED, Visitor::STATUS_ARCHIVED],
            Visitor::STATUS_ARCHIVED => [],
        ];
    }

    public static function allowsTransition(string $from, string $to): bool
    {
        return in_array($to, self::transitions()[$from] ?? [], true);
    }

    public static function requireTransition(string $from, string $to): void
    {
        if (! in_array($from, self::states(), true)) {
            throw BusinessRejection::forCode('crm.visitor_unknown_status', sprintf('unknown visitor status %s', $from));
        }
        if (! self::allowsTransition($from, $to)) {
            throw BusinessRejection::forCode('crm.visitor_transition_forbidden', sprintf('visitor transition %s -> %s is not allowed', $from, $to));
        }
    }
}
