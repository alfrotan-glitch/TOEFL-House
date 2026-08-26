<?php

declare(strict_types=1);

namespace App\Modules\Academic\Models;

use Illuminate\Database\Eloquent\Model;

/**
 * Independent review request against a released result or an approved
 * progression decision; the original decision is always retained.
 *
 * @property string $id
 * @property string $student_id
 * @property string $subject_type
 * @property string $subject_id
 * @property string $reason
 * @property string $lifecycle_state
 * @property string|null $assigned_reviewer_id
 * @property string|null $outcome
 * @property string|null $outcome_evidence
 */
final class AcademicAppeal extends Model
{
    public $incrementing = false;

    protected $keyType = 'string';

    protected $fillable = ['id', 'student_id', 'subject_type', 'subject_id', 'reason', 'lifecycle_state', 'assigned_reviewer_id', 'outcome', 'outcome_evidence', 'decided_by'];
}
