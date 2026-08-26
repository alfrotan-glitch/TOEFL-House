<?php

declare(strict_types=1);

namespace App\Modules\Academic\Models;

use Illuminate\Database\Eloquent\Model;

/**
 * Explicit, dated, appealable progression decision for one student in one
 * class — advance or repeat. No student advances automatically.
 *
 * @property string $id
 * @property string $student_id
 * @property string $class_id
 * @property string $outcome
 * @property string $reason
 * @property string $lifecycle_state
 * @property string|null $superseded_by_id
 */
final class ProgressionDecision extends Model
{
    public $incrementing = false;

    protected $keyType = 'string';

    protected $fillable = ['id', 'student_id', 'class_id', 'outcome', 'reason', 'lifecycle_state', 'superseded_by_id', 'proposed_by', 'reviewed_by', 'approved_by'];
}
