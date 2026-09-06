<?php

declare(strict_types=1);

namespace App\Modules\Outbox\Models;

use Illuminate\Database\Eloquent\Model;

/**
 * Rebuild request emitted by an event consumer. It identifies the source
 * event and projection but never duplicates the source fact or its value.
 */
final class ProjectionInvalidation extends Model
{
    public $incrementing = false;

    protected $keyType = 'string';

    protected $fillable = [
        'id', 'projection_key', 'event_id', 'aggregate_type', 'aggregate_id',
        'status', 'reason', 'requested_at', 'rebuilt_at', 'last_error',
    ];

    protected $casts = [
        'requested_at' => 'datetime',
        'rebuilt_at' => 'datetime',
    ];
}
