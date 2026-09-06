<?php

declare(strict_types=1);

namespace App\Modules\Academic\Models;

use Illuminate\Database\Eloquent\Model;
use Illuminate\Database\Eloquent\Relations\BelongsTo;
use Illuminate\Database\Eloquent\Relations\HasMany;

/**
 * Effective-dated teaching assignment of a person to a class; substitution
 * is a separate assignment, history is retained.
 *
 * @property string $id
 * @property string $class_id
 * @property string $teacher_person_id
 * @property string|null $teacher_profile_id
 * @property string|null $lifecycle_state
 * @property string|null $branch_id
 * @property string|null $campus_id
 * @property string|null $organization_id
 * @property string $effective_from
 * @property string|null $effective_to
 */
final class TeacherAssignment extends Model
{
    public $incrementing = false;

    protected $keyType = 'string';

    protected $fillable = [
        'id', 'class_id', 'teacher_person_id', 'teacher_profile_id', 'lifecycle_state', 'branch_id', 'campus_id',
        'organization_id', 'effective_from', 'effective_to', 'assigned_by', 'assignment_reason',
    ];

    /** @return BelongsTo<TeacherProfile, $this> */
    public function teacherProfile(): BelongsTo { return $this->belongsTo(TeacherProfile::class, 'teacher_profile_id'); }

    /** @return HasMany<TeacherAssignmentSkill, $this> */
    public function skills(): HasMany { return $this->hasMany(TeacherAssignmentSkill::class, 'teacher_assignment_id'); }
}
