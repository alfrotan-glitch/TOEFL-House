<?php

declare(strict_types=1);

namespace App\Modules\Academic\Models;

use Illuminate\Database\Eloquent\Model;

/**
 * Explicit, dated, appealable progression decision for one student in one
 * class — advance or repeat. No student advances automatically. When the
 * class targets a level, the decision carries from/to level, repeat count,
 * basis and optional assessment result evidence (ADR-018).
 *
 * @property string $id
 * @property string $student_id
 * @property string $class_id
 * @property string $outcome
 * @property string $reason
 * @property string $lifecycle_state
 * @property string|null $superseded_by_id
 * @property string|null $from_level_id
 * @property string|null $to_level_id
 * @property string|null $assessment_result_id
 * @property string|null $basis
 * @property int|null $repeat_count
 */
final class ProgressionDecision extends Model
{
    public $incrementing = false;

    protected $keyType = 'string';

    protected $fillable = ['id', 'student_id', 'class_id', 'outcome', 'reason', 'lifecycle_state', 'superseded_by_id', 'proposed_by', 'reviewed_by', 'approved_by', 'from_level_id', 'to_level_id', 'assessment_result_id', 'basis', 'repeat_count'];

    protected $casts = [
        'repeat_count' => 'integer',
    ];
}
