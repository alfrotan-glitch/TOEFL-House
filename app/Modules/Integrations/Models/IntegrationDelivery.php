<?php

declare(strict_types=1);

namespace App\Modules\Integrations\Models;

use Illuminate\Database\Eloquent\Model;

/**
 * One outbound delivery through an adapter: identity (endpoint, key,
 * source, action, payload) is fixed by trigger; progress — attempts,
 * bounded retries, backoff, terminal delivery or dead-letter — rebuilds.
 *
 * @property string $id
 * @property string $status
 * @property array<string, mixed> $payload
 * @property int $attempts
 */
final class IntegrationDelivery extends Model
{
    public $incrementing = false;

    protected $keyType = 'string';

    protected $fillable = ['id', 'endpoint_id', 'idempotency_key', 'correlation_id', 'source_type', 'source_id', 'contract_action', 'payload', 'payload_digest', 'status', 'attempts', 'max_attempts', 'requeues', 'next_run_at', 'last_error', 'delivered_ref', 'delivered_at', 'created_by'];

    protected $casts = ['payload' => 'array', 'next_run_at' => 'datetime', 'delivered_at' => 'datetime'];
}
