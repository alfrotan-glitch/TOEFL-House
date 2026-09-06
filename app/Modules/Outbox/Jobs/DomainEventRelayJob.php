<?php

declare(strict_types=1);

namespace App\Modules\Outbox\Jobs;

use App\Modules\Integrations\Domain\JobHandler;
use App\Modules\Outbox\Domain\DomainEventRelay;
use App\Support\Authorization\Actor;
use App\Support\Errors\BusinessRejection;

/** Scheduled relay adapter; durable scheduling remains owned by Integrations. */
final class DomainEventRelayJob implements JobHandler
{
    public function __construct(private readonly DomainEventRelay $relay) {}

    /** @param array<string, mixed> $context @return array<string, int> */
    public function handle(array $context): array
    {
        $runBy = trim((string) ($context['run_by'] ?? ''));
        if ($runBy === '') {
            throw BusinessRejection::forCode('outbox.relay_operator_required', 'a scheduled relay requires a durable authenticated run_by actor');
        }

        return $this->relay->relay(
            new Actor($runBy, 'Domain Event Relay'),
            (int) ($context['batch'] ?? 100),
        );
    }
}
