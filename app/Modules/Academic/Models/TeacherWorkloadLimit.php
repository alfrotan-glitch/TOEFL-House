<?php

declare(strict_types=1);

namespace App\Modules\Academic\Models;

use Illuminate\Database\Eloquent\Model;

/** Effective weekly workload ceiling for timetable admission. */
final class TeacherWorkloadLimit extends Model
{
    public $incrementing = false;
    protected $keyType = 'string';
    protected $table = 'teacher_workload_limits';
    protected $fillable = ['id', 'teacher_profile_id', 'branch_id', 'max_hours_per_week', 'effective_from', 'effective_to', 'lifecycle_state', 'approved_by', 'evidence_ref'];
}
