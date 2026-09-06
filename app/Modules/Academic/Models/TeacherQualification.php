<?php

declare(strict_types=1);

namespace App\Modules\Academic\Models;

use Illuminate\Database\Eloquent\Model;
use Illuminate\Database\Eloquent\Relations\BelongsTo;

/** Independently evidenced qualification; verification is not client-invented. */
final class TeacherQualification extends Model
{
    public $incrementing = false;
    protected $keyType = 'string';
    protected $fillable = ['id', 'teacher_profile_id', 'qualification_type', 'title', 'issuer', 'evidence_ref', 'submitted_by', 'valid_from', 'valid_to', 'lifecycle_state', 'verified_by', 'verified_at'];

    /** @return BelongsTo<TeacherProfile, $this> */
    public function teacherProfile(): BelongsTo { return $this->belongsTo(TeacherProfile::class); }
}
