<?php

declare(strict_types=1);

namespace App\Modules\Outbox\Domain;

use App\Modules\Communication\Domain\NotificationProjectionConsumer;
use App\Modules\Outbox\Consumers\ProjectionInvalidationConsumer;
use App\Modules\WorkManagement\Domain\WorkflowCompletionConsumer;
use App\Modules\WorkManagement\Domain\WorkflowProjectionConsumer;
use App\Support\Errors\BusinessRejection;

/** Closed registry: no arbitrary event handler class may be configured at runtime. */
final class EventConsumerCatalog
{
    /** @var array<string, class-string<EventConsumer>> */
    private const CONSUMERS = [
        'projection.invalidation' => ProjectionInvalidationConsumer::class,
        'communication.notification_projection' => NotificationProjectionConsumer::class,
        'workflow.intent_projection' => WorkflowProjectionConsumer::class,
        'workflow.source_completion' => WorkflowCompletionConsumer::class,
    ];

    /** @return list<string> */
    public static function keys(): array
    {
        return array_keys(self::CONSUMERS);
    }

    /** @return class-string<EventConsumer> */
    public static function consumerFor(string $key): string
    {
        $consumer = self::CONSUMERS[$key] ?? null;
        if ($consumer === null) {
            throw BusinessRejection::forCode('outbox.consumer_unknown', sprintf('consumer %s is not in the catalog', $key));
        }

        return $consumer;
    }
}
