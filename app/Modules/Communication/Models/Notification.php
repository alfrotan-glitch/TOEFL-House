<?php

declare(strict_types=1);

namespace App\Modules\Communication\Models;

use Illuminate\Database\Eloquent\Model;

/**
 * Actor-specific notification projection. It informs a recipient but never
 * owns the source task, approval, exception, permission, or domain state.
 */
final class Notification extends Model
{
    public $incrementing = false;

    protected $keyType = 'string';

    protected $fillable = [
        'id', 'event_id', 'recipient_actor_id', 'source_type', 'source_id',
        'dedupe_key', 'title', 'body_ref', 'severity', 'scope_type', 'organization_id', 'branch_id',
        'lifecycle_state', 'read_at', 'dismissed_at', 'expires_at',
    ];

    protected $casts = [
        'read_at' => 'datetime',
        'dismissed_at' => 'datetime',
        'expires_at' => 'datetime',
    ];
}
