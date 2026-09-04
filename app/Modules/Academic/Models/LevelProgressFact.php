<?php

declare(strict_types=1);

namespace App\Modules\Academic\Models;

use Illuminate\Database\Eloquent\Model;
use Illuminate\Database\Eloquent\Relations\BelongsTo;

/**
 * Immutable academic history fact produced by an approved level-aware
 * progression decision. Academic history is never mutated; corrections flow
 * through the progression appeal/supersede chain.
 */
final class LevelProgressFact extends Model
{
    public const OUTCOME_ADVANCE = 'advance';

    public const OUTCOME_REPEAT = 'repeat';

    public $incrementing = false;

    protected $keyType = 'string';

    protected $fillable = [
        'id', 'student_id', 'program_version_id', 'level_id', 'to_level_id',
        'class_id', 'offering_id', 'academic_period_id', 'decision_id',
        'assessment_result_id', 'outcome', 'repeat_count', 'achieved_at',
    ];

    protected $casts = [
        'achieved_at' => 'datetime',
        'repeat_count' => 'integer',
    ];

    /** @return BelongsTo<ProgramVersionLevel, $this> */
    public function level(): BelongsTo
    {
        return $this->belongsTo(ProgramVersionLevel::class, 'level_id');
    }

    /** @return BelongsTo<ProgramVersionLevel, $this> */
    public function toLevel(): BelongsTo
    {
        return $this->belongsTo(ProgramVersionLevel::class, 'to_level_id');
    }

    /** @return BelongsTo<ProgressionDecision, $this> */
    public function decision(): BelongsTo
    {
        return $this->belongsTo(ProgressionDecision::class, 'decision_id');
    }

    /** @return BelongsTo<AssessmentResult, $this> */
    public function assessmentResult(): BelongsTo
    {
        return $this->belongsTo(AssessmentResult::class, 'assessment_result_id');
    }
}
