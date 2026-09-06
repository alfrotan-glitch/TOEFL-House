<?php

declare(strict_types=1);

namespace App\Modules\WorkManagement\Models;

use Illuminate\Database\Eloquent\Model;

/** Time-bounded queue membership; it is not a substitute for source authorization. */
final class QueueMembership extends Model
{
    protected $table = 'work_queue_memberships';

    public $incrementing = false;

    protected $keyType = 'string';

    protected $fillable = [
        'id', 'actor_id', 'queue_key', 'organization_id', 'branch_id', 'lifecycle_state',
        'effective_from', 'effective_to', 'created_by',
    ];

    protected $casts = ['effective_from' => 'datetime', 'effective_to' => 'datetime'];
}
