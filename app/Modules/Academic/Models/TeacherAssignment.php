<?php

declare(strict_types=1);

namespace App\Modules\Academic\Models;

use Illuminate\Database\Eloquent\Model;

/**
 * Effective-dated teaching assignment of a person to a class; substitution
 * is a separate assignment, history is retained.
 *
 * @property string $id
 * @property string $class_id
 * @property string $teacher_person_id
 * @property string $effective_from
 * @property string|null $effective_to
 */
final class TeacherAssignment extends Model
{
    public $incrementing = false;

    protected $keyType = 'string';

    protected $fillable = ['id', 'class_id', 'teacher_person_id', 'effective_from', 'effective_to'];
}
