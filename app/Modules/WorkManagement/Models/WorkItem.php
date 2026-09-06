<?php

declare(strict_types=1);

namespace App\Modules\WorkManagement\Models;

use Illuminate\Database\Eloquent\Model;
use Illuminate\Database\Eloquent\Relations\BelongsTo;
use Illuminate\Database\Eloquent\Relations\HasMany;

/**
 * An actionable coordination instance. `kind` distinguishes task, approval,
 * and exception; it never stores the domain decision or replaces a source
 * aggregate's lifecycle.
 */
final class WorkItem extends Model
{
    public $incrementing = false;

    protected $keyType = 'string';

    protected $fillable = [
        'id', 'workflow_instance_id', 'kind', 'title', 'description',
        'source_type', 'source_id', 'action_key', 'source_version', 'organization_id', 'branch_id',
        'assigned_to', 'queue_key', 'priority', 'due_at', 'lifecycle_state',
        'claimed_at', 'completed_at', 'completed_by', 'created_by',
    ];

    protected $casts = ['due_at' => 'datetime', 'claimed_at' => 'datetime', 'completed_at' => 'datetime'];

    /** @return BelongsTo<WorkflowInstance, $this> */
    public function workflow(): BelongsTo
    {
        return $this->belongsTo(WorkflowInstance::class, 'workflow_instance_id');
    }

    /** @return HasMany<WorkItemHistory, $this> */
    public function history(): HasMany
    {
        return $this->hasMany(WorkItemHistory::class, 'work_item_id')->orderBy('occurred_at');
    }
}
