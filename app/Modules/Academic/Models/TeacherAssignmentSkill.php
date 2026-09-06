<?php

declare(strict_types=1);

namespace App\Modules\Academic\Models;

use Illuminate\Database\Eloquent\Model;

/**
 * Skill dimension of a teaching assignment: which skills the teacher
 * delivers in that class. Append-only evidence (schema trigger); a change
 * is a new effective-dated assignment.
 *
 * @property string $id
 * @property string $teacher_assignment_id
 * @property string $skill_id
 */
final class TeacherAssignmentSkill extends Model
{
    public $incrementing = false;

    protected $keyType = 'string';

    protected $fillable = ['id', 'teacher_assignment_id', 'skill_id'];
}
