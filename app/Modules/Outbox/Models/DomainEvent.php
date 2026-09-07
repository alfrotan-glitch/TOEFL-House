<?php

declare(strict_types=1);

namespace App\Modules\Outbox\Models;

use App\Support\Errors\BusinessRejection;
use Illuminate\Database\Eloquent\Model;

/**
 * Immutable transaction log of successful domain operations. This is the
 * canonical event/outbox boundary; integration_deliveries is only the
 * endpoint-specific delivery projection and must not become domain truth.
 * Its event clock is copied by the database from the immutable audit parent.
 *
 * @property \Carbon\CarbonImmutable|null $occurred_at
 * @property 'audit_event'|null $occurred_time_basis
 */
final class DomainEvent extends Model
{
    public $incrementing = false;

    public $timestamps = true;

    protected $table = 'domain_events';

    protected $keyType = 'string';

    protected $fillable = [
        'id', 'audit_event_id', 'actor_id', 'event_type', 'event_version',
        'aggregate_type', 'aggregate_id', 'correlation_id', 'payload',
        'payload_digest', 'context',
    ];

    protected $casts = [
        'payload' => 'array',
        'context' => 'array',
        'occurred_at' => 'immutable_datetime',
    ];

    public function save(array $options = []): bool
    {
        if ($this->exists) {
            throw BusinessRejection::forCode('outbox.immutable', 'domain events are append-only');
        }

        return parent::save($options);
    }

    public function delete(): bool
    {
        throw BusinessRejection::forCode('outbox.immutable', 'domain events are append-only');
    }

    public function forceDelete(): bool
    {
        throw BusinessRejection::forCode('outbox.immutable', 'domain events are append-only');
    }
}
