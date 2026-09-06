<?php

declare(strict_types=1);

namespace App\Modules\Outbox\Consumers;

use App\Modules\Outbox\Domain\EventConsumer;
use App\Modules\Outbox\Domain\ProjectionCatalog;
use App\Modules\Outbox\Models\DomainEvent;
use App\Modules\Outbox\Models\ProjectionInvalidation;
use App\Support\Identifiers\RandomIdentifier;

/**
 * Turns committed domain events into replayable projection invalidations.
 * The consumer never calculates domain state and is safe to run repeatedly
 * because (projection_key, event_id) is unique.
 */
final class ProjectionInvalidationConsumer implements EventConsumer
{
    public function key(): string
    {
        return 'projection.invalidation';
    }

    public function supports(DomainEvent $event): bool
    {
        return true;
    }

    public function consume(DomainEvent $event): void
    {
        foreach ($this->projectionKeys($event) as $projectionKey) {
            ProjectionInvalidation::query()->firstOrCreate(
                ['projection_key' => $projectionKey, 'event_id' => $event->id],
                [
                    'id' => RandomIdentifier::new(),
                    'aggregate_type' => $event->aggregate_type,
                    'aggregate_id' => $event->aggregate_id,
                    'status' => 'pending',
                    'reason' => $event->event_type,
                    'requested_at' => now(),
                ],
            );
        }
    }

    /** @return list<string> */
    private function projectionKeys(DomainEvent $event): array
    {
        $keys = ['workspace'];
        $type = strtolower($event->aggregate_type.' '.$event->event_type);

        if (preg_match('/student|person|visitor|applicant|admission/', $type) === 1) {
            $keys[] = 'search';
        }
        if (preg_match('/finance|fund|payroll|academic|enrollment|placement|student|visitor|admission|attendance/', $type) === 1) {
            $keys[] = 'reporting';
        }
        $after = $event->payload['after'] ?? null;
        $hasNotificationIntent = is_array($event->payload['notification'] ?? null) || (is_array($after) && is_array($after['notification'] ?? null));
        if (preg_match('/communication|message|notification/', $type) === 1 || $hasNotificationIntent) {
            $keys[] = 'communication';
            $keys[] = 'notifications';
        }

        return array_values(array_intersect(ProjectionCatalog::keys(), array_unique($keys)));
    }
}
