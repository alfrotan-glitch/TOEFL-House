<?php

declare(strict_types=1);

namespace App\Modules\Outbox\Models;

use Illuminate\Database\Eloquent\Model;

/**
 * Idempotency and retry ledger for one (domain event, consumer) pair. This
 * is delivery/processing state, not domain truth; it is safe to rebuild or
 * replay from the immutable domain_events log.
 */
final class ConsumerReceipt extends Model
{
    protected $table = 'event_consumer_receipts';

    public $incrementing = false;

    protected $keyType = 'string';

    protected $fillable = [
        'id', 'event_id', 'consumer_key', 'status', 'attempts', 'max_attempts',
        'next_attempt_at', 'last_error', 'processed_at',
    ];

    protected $casts = [
        'next_attempt_at' => 'datetime',
        'claimed_at' => 'datetime',
        'lease_until' => 'datetime',
        'processed_at' => 'datetime',
    ];
}
