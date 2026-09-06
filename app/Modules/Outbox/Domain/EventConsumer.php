<?php

declare(strict_types=1);

namespace App\Modules\Outbox\Domain;

use App\Modules\Outbox\Models\DomainEvent;

/**
 * An idempotent internal consumer of one committed domain event. Consumers
 * may rebuild projections or enqueue downstream work, but may not rewrite the
 * source aggregate represented by the event.
 */
interface EventConsumer
{
    public function key(): string;

    public function supports(DomainEvent $event): bool;

    public function consume(DomainEvent $event): void;
}
