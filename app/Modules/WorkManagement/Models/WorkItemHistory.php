<?php

declare(strict_types=1);

namespace App\Modules\WorkManagement\Models;

use Illuminate\Database\Eloquent\Model;

/** Append-only coordination evidence; it is not a domain event or audit substitute. */
final class WorkItemHistory extends Model
{
    protected $table = 'work_item_history';

    public $incrementing = false;

    public $timestamps = false;

    protected $keyType = 'string';

    protected $fillable = [
        'id', 'workflow_instance_id', 'work_item_id', 'event_type', 'actor_id',
        'from_state', 'to_state', 'metadata', 'occurred_at',
    ];

    protected $casts = ['metadata' => 'array', 'occurred_at' => 'datetime'];
}
