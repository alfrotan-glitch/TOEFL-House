<?php

declare(strict_types=1);

namespace App\Modules\Students\Models;

use Illuminate\Database\Eloquent\Model;

/**
 * Append-only student freeze/resume fact. The current hold state is derived
 * from the latest action row ('freeze' = held, 'resume' = not held);
 * history is never overwritten.
 *
 * @property string $id
 * @property string $student_id
 * @property string $action
 * @property string $effective_from
 * @property string $reason
 * @property string $actor_id
 */
final class StudentHoldEvent extends Model
{
    public $incrementing = false;

    protected $keyType = 'string';

    protected $fillable = ['id', 'student_id', 'action', 'effective_from', 'reason', 'actor_id'];
}
