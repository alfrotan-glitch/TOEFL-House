<?php

declare(strict_types=1);

namespace App\Modules\Outbox\Domain;

use App\Modules\Audit\Models\AuditEvent;
use App\Modules\Outbox\Models\DomainEvent;
use App\Support\Identifiers\RandomIdentifier;
use Illuminate\Support\Facades\DB;

/**
 * Records an event in the caller's transaction. It deliberately performs no
 * dispatch and no network I/O: commit is the publication boundary, while an
 * integration worker may later project this immutable fact into
 * integration_deliveries with endpoint-specific idempotency.
 */
final class TransactionalEventRecorder
{
    /** @param array<string, mixed> $payload */
    public function record(AuditEvent $auditEvent, array $payload): DomainEvent
    {
        $encoded = json_encode($payload, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES) ?: '{}';
        // Hash PostgreSQL's canonical jsonb representation, not PHP's
        // insertion-order JSON. The database insert guard can therefore bind
        // the digest to the stored payload even when keys are reordered by
        // jsonb.
        $payloadDigest = (string) (DB::selectOne(
            "SELECT encode(digest((?::jsonb)::text, 'sha256'), 'hex') AS digest",
            [$encoded],
        )->digest ?? '');

        return DomainEvent::query()->create([
            'id' => RandomIdentifier::new(),
            'audit_event_id' => $auditEvent->id,
            'actor_id' => $auditEvent->actor_id,
            'event_type' => $auditEvent->operation,
            'event_version' => 1,
            'aggregate_type' => $auditEvent->target_type,
            'aggregate_id' => $auditEvent->target_id,
            'correlation_id' => $auditEvent->correlation_id,
            'payload' => $payload,
            'context' => DomainEventContext::from($auditEvent, $payload),
            'payload_digest' => $payloadDigest,
            'occurred_at' => $auditEvent->occurred_at,
        ]);
    }
}
