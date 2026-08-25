<?php

declare(strict_types=1);

namespace App\Modules\Access\Models;

use App\Modules\Access\Domain\AccessLifecycle;
use Illuminate\Database\Eloquent\Model;

/**
 * Effective-dated assignment of a person to a position; the effective
 * window expires automatically and history is never rewritten.
 *
 * @property string $id
 * @property string $person_id
 * @property string $position_id
 * @property string $lifecycle_state
 * @property string $effective_from
 * @property string|null $effective_to
 */
final class PositionAssignment extends Model
{
    public $incrementing = false;

    protected $keyType = 'string';

    protected $fillable = ['id', 'person_id', 'position_id', 'lifecycle_state', 'effective_from', 'effective_to', 'assigned_by'];

    public function isActive(): bool
    {
        return $this->lifecycle_state === AccessLifecycle::STATE_ACTIVE;
    }
}
