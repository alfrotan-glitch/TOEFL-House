<?php

declare(strict_types=1);

namespace App\Modules\Academic\Models;

use Illuminate\Database\Eloquent\Model;

/**
 * Official completion decision: eligibility against program requirements
 * (with basis; approved exceptions are cited there).
 *
 * @property string $id
 * @property string $student_id
 * @property string $program_version_id
 * @property string $outcome
 * @property string $basis
 * @property string $lifecycle_state
 */
final class GraduationDecision extends Model
{
    public $incrementing = false;

    protected $keyType = 'string';

    protected $fillable = ['id', 'student_id', 'program_version_id', 'outcome', 'basis', 'lifecycle_state', 'proposed_by', 'reviewed_by', 'approved_by'];
}
