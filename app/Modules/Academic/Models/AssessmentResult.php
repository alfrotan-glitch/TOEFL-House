<?php

declare(strict_types=1);

namespace App\Modules\Academic\Models;

use Illuminate\Database\Eloquent\Model;
use Illuminate\Database\Eloquent\Relations\BelongsTo;

/**
 * Calculated result of one attempt through the ordered review chain; a
 * correction appends a new result row referencing the one it corrects.
 *
 * @property string $id
 * @property string $attempt_id
 * @property string $score
 * @property string $lifecycle_state
 * @property string|null $corrects_id
 * @property string|null $correction_reason
 */
final class AssessmentResult extends Model
{
    public $incrementing = false;

    protected $keyType = 'string';

    protected $fillable = ['id', 'attempt_id', 'score', 'lifecycle_state', 'corrects_id', 'correction_reason', 'scored_by'];

    /** @return BelongsTo<AssessmentAttempt, $this> */
    public function attempt(): BelongsTo
    {
        return $this->belongsTo(AssessmentAttempt::class);
    }
}
