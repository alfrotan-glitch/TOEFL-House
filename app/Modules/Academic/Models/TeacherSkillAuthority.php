<?php

declare(strict_types=1);

namespace App\Modules\Academic\Models;

use Illuminate\Database\Eloquent\Model;
use Illuminate\Database\Eloquent\Relations\BelongsTo;

/** Effective subject/course authority, separate from assignment delivery evidence. */
final class TeacherSkillAuthority extends Model
{
    public $incrementing = false;
    protected $keyType = 'string';
    protected $table = 'teacher_skill_authorities';
    protected $fillable = ['id', 'teacher_profile_id', 'skill_id', 'branch_id', 'authority_kind', 'effective_from', 'effective_to', 'lifecycle_state', 'approved_by', 'evidence_ref'];

    /** @return BelongsTo<TeacherProfile, $this> */
    public function teacherProfile(): BelongsTo { return $this->belongsTo(TeacherProfile::class); }

    /** @return BelongsTo<Skill, $this> */
    public function skill(): BelongsTo { return $this->belongsTo(Skill::class); }
}
