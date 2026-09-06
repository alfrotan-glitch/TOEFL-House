<?php

declare(strict_types=1);

namespace App\Modules\WorkManagement\Models;

use Illuminate\Database\Eloquent\Model;
use Illuminate\Database\Eloquent\Relations\HasMany;

/** Coordination state only; source domain lifecycle remains authoritative. */
final class WorkflowInstance extends Model
{
    public $incrementing = false;

    protected $keyType = 'string';

    protected $fillable = [
        'id', 'definition_key', 'definition_version', 'source_type', 'source_id',
        'source_event_id', 'correlation_id', 'organization_id', 'branch_id', 'lifecycle_state', 'started_by',
        'started_at', 'closed_at', 'context',
    ];

    protected $casts = ['context' => 'array', 'started_at' => 'datetime', 'closed_at' => 'datetime'];

    /** @return HasMany<WorkItem, $this> */
    public function workItems(): HasMany
    {
        return $this->hasMany(WorkItem::class, 'workflow_instance_id');
    }
}
