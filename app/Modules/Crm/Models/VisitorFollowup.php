<?php

declare(strict_types=1);

namespace App\Modules\Crm\Models;

use App\Modules\Identity\Models\Person;
use Illuminate\Database\Eloquent\Model;
use Illuminate\Database\Eloquent\Relations\BelongsTo;

/**
 * Scheduled next action on a visitor. Content is fixed at creation; only the
 * status advances (open -> done|cancelled) with completion evidence.
 *
 * @property string $id
 * @property string $visitor_id
 * @property string $assigned_to
 * @property string $scheduled_for
 * @property string $title
 * @property string|null $notes
 * @property string $status
 * @property string $created_by
 * @property string|null $completed_by
 * @property string|null $completed_at
 * @property string $correlation_id
 */
final class VisitorFollowup extends Model
{
    public const STATUS_OPEN = 'open';

    public const STATUS_DONE = 'done';

    public const STATUS_CANCELLED = 'cancelled';

    public $incrementing = false;

    protected $keyType = 'string';

    protected $fillable = [
        'id', 'visitor_id', 'assigned_to', 'scheduled_for', 'title', 'notes', 'status',
        'created_by', 'completed_by', 'completed_at', 'correlation_id',
    ];

    /** @return BelongsTo<Visitor, $this> */
    public function visitor(): BelongsTo
    {
        return $this->belongsTo(Visitor::class);
    }

    /** @return BelongsTo<Person, $this> */
    public function assignee(): BelongsTo
    {
        return $this->belongsTo(Person::class, 'assigned_to');
    }

    /** @return BelongsTo<Person, $this> */
    public function creator(): BelongsTo
    {
        return $this->belongsTo(Person::class, 'created_by');
    }
}
