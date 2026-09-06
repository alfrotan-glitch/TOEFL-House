<?php

declare(strict_types=1);

namespace App\Modules\Academic\Models;

use Illuminate\Database\Eloquent\Model;

/** Effective branch/campus provenance granted to a teacher profile. */
final class TeacherProfileBranch extends Model
{
    public $incrementing = false;
    protected $keyType = 'string';
    protected $table = 'teacher_profile_branches';
    protected $fillable = ['id', 'teacher_profile_id', 'branch_id', 'effective_from', 'effective_to', 'lifecycle_state', 'provenance_reason', 'approved_by'];
}
