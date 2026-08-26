<?php

declare(strict_types=1);

namespace App\Modules\Integrations\Models;

use Illuminate\Database\Eloquent\Model;

/**
 * One received external event: authenticated on intake, deduplicated per
 * (endpoint, external id) for accepted events, processed exactly once;
 * rejected evidence is retained without blocking a corrected retry.
 *
 * @property string $id
 * @property string $status
 * @property array<string, mixed> $payload
 */
final class InboundEvent extends Model
{
    public $incrementing = false;

    protected $keyType = 'string';

    protected $fillable = ['id', 'endpoint_id', 'external_id', 'event_type', 'payload', 'payload_digest', 'signature_verified', 'status', 'error', 'processed_at', 'processed_by', 'received_by'];

    protected $casts = ['payload' => 'array', 'processed_at' => 'datetime'];
}
