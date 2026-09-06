<?php

declare(strict_types=1);

namespace App\Modules\Outbox\Domain;

/**
 * Closed registry of rebuildable read projections. A projection key is an
 * operational read model, never a business authority. Direct source queries
 * remain valid while a materialized projection is stale or being rebuilt.
 */
final class ProjectionCatalog
{
    /** @var array<string, array{owner: string, rebuild_mode: string, source_policy: string}> */
    private const PROJECTIONS = [
        'workspace' => [
            'owner' => 'workspace',
            'rebuild_mode' => 'source_query_or_event_refresh',
            'source_policy' => 'effective Access, assignments, domain work, and exceptions',
        ],
        'search' => [
            'owner' => 'search',
            'rebuild_mode' => 'source_reindex',
            'source_policy' => 'branch-provenanced Student and Visitor records only',
        ],
        'reporting' => [
            'owner' => 'reporting',
            'rebuild_mode' => 'metric_calculator_replay',
            'source_policy' => 'MetricCatalog source owners and authoritative periods',
        ],
        'communication' => [
            'owner' => 'communication',
            'rebuild_mode' => 'message_projection_replay',
            'source_policy' => 'committed communication intent and delivery evidence',
        ],
        'notifications' => [
            'owner' => 'communication',
            'rebuild_mode' => 'explicit-recipient-event-replay',
            'source_policy' => 'notification intents with actor recipient and source link',
        ],
    ];

    /** @return list<string> */
    public static function keys(): array
    {
        return array_keys(self::PROJECTIONS);
    }

    /** @return array{owner: string, rebuild_mode: string, source_policy: string} */
    public static function definition(string $key): array
    {
        return self::PROJECTIONS[$key];
    }
}
