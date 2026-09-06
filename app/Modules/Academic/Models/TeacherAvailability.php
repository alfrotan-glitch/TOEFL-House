<?php

declare(strict_types=1);

namespace App\Modules\Academic\Models;

use Illuminate\Database\Eloquent\Model;

/** Effective recurring availability or unavailability for timetable checks. */
final class TeacherAvailability extends Model
{
    public $incrementing = false;
    protected $keyType = 'string';
    protected $table = 'teacher_availabilities';
    protected $fillable = ['id', 'teacher_profile_id', 'weekday', 'starts_at', 'ends_at', 'effective_from', 'effective_to', 'lifecycle_state', 'availability_kind', 'branch_id'];
}
