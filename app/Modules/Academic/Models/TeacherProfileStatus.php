<?php

declare(strict_types=1);

namespace App\Modules\Academic\Models;

use Illuminate\Database\Eloquent\Model;

/** Append-only Teacher profile lifecycle fact. */
final class TeacherProfileStatus extends Model
{
    public $incrementing = false;
    protected $keyType = 'string';
    protected $table = 'teacher_profile_statuses';
    protected $fillable = ['id', 'teacher_profile_id', 'status', 'effective_from', 'reason', 'actor_id'];
}
