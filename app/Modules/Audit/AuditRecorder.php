<?php

declare(strict_types=1);

namespace App\Modules\Audit;

use App\Modules\Audit\Models\AuditEvent;
use App\Modules\Outbox\Domain\TransactionalEventRecorder;
use App\Support\Errors\DomainError;
use App\Support\Identifiers\RandomIdentifier;

/**
 * Records material evidence inside the caller's owning transaction: a fact
 * without audit evidence is not complete per the boundary contract. A
 * successful operation also receives one immutable domain event through the
 * transactional outbox boundary; denied attempts remain audit evidence only.
 */
final class AuditRecorder
{
    public function __construct(private readonly TransactionalEventRecorder $events) {}

    /**
     * @param  array<string, mixed>|null  $beforeState
     * @param  array<string, mixed>|null  $afterState
     */
    public function record(
        string $actorId,
        string $operation,
        string $targetType,
        string $targetId,
        ?array $beforeState,
        ?array $afterState,
        ?string $correlationId = null,
    ): AuditEvent {
        $auditEvent = AuditEvent::query()->create([
            'id' => RandomIdentifier::new(),
            'actor_id' => $actorId,
            'operation' => $operation,
            'target_type' => $targetType,
            'target_id' => $targetId,
            'correlation_id' => $correlationId ?? DomainError::newCorrelationId(),
            'before_state' => $beforeState,
            'after_state' => $afterState,
            // PostgreSQL assigns the immutable UTC event clock. Do not pass
            // application's `now()` across this authority boundary.
        ]);
        /** @var AuditEvent $auditEvent */
        $auditEvent = AuditEvent::query()->whereKey($auditEvent->id)->firstOrFail();

        if (! str_ends_with($operation, '.denied')) {
            $this->events->record($auditEvent, [
                'operation' => $operation,
                'before' => $beforeState,
                'after' => $afterState,
            ]);
        }

        return $auditEvent;
    }
}
