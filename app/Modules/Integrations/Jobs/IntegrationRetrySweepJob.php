<?php

declare(strict_types=1);

namespace App\Modules\Integrations\Jobs;

use App\Modules\Integrations\Domain\DeliveryProcessor;
use App\Modules\Integrations\Domain\JobHandler;
use App\Modules\Integrations\Models\IntegrationDelivery;
use App\Support\Authorization\Actor;

/**
 * Scheduled integration retry sweep (architecture 16): consumes committed
 * delivery facts, retries every due delivery through the shared delivery
 * core under the operating actor's authorization, each delivery in its
 * own transaction so partial failure never rolls back siblings.
 */
final class IntegrationRetrySweepJob implements JobHandler
{
    public function __construct(private readonly DeliveryProcessor $processor) {}

    /** @param  array<string, mixed>  $context @return array<string, int> */
    public function handle(array $context): array
    {
        $operator = new Actor((string) ($context['run_by'] ?? 'system'), 'Integration Sweep');
        $due = IntegrationDelivery::query()
            ->whereIn('status', ['queued', 'failed'])
            ->where(fn ($query) => $query->whereNull('next_run_at')->orWhere('next_run_at', '<=', now()))
            ->orderBy('created_at')
            ->pluck('id');

        $summary = ['considered' => $due->count(), 'delivered' => 0, 'retry_scheduled' => 0, 'dead_letter' => 0, 'skipped' => 0];
        foreach ($due as $deliveryId) {
            $outcome = $this->processor->processId($deliveryId, $operator);
            $summary['skipped'] += str_starts_with($outcome['outcome'], 'skipped') ? 1 : 0;
            $summary['delivered'] += $outcome['outcome'] === 'delivered' ? 1 : 0;
            $summary['retry_scheduled'] += $outcome['outcome'] === 'retry_scheduled' ? 1 : 0;
            $summary['dead_letter'] += $outcome['outcome'] === 'dead_letter' ? 1 : 0;
        }

        return $summary;
    }
}
