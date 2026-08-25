<?php

declare(strict_types=1);

namespace App\Modules\Audit;

use App\Modules\Audit\Models\AuditEvent;
use App\Support\Errors\DomainError;
use App\Support\Identifiers\RandomIdentifier;

/**
 * Records material evidence inside the caller's owning transaction: a fact
 * without audit evidence is not complete per the boundary contract.
 */
final class AuditRecorder
{
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
        return AuditEvent::query()->create([
            'id' => RandomIdentifier::new(),
            'actor_id' => $actorId,
            'operation' => $operation,
            'target_type' => $targetType,
            'target_id' => $targetId,
            'correlation_id' => $correlationId ?? DomainError::newCorrelationId(),
            'before_state' => $beforeState,
            'after_state' => $afterState,
            'occurred_at' => now(),
        ]);
    }
}
