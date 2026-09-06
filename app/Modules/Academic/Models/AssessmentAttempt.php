<?php

declare(strict_types=1);

namespace App\Modules\Academic\Models;

use Illuminate\Database\Eloquent\Model;

/**
 * Raw evidence container of one placement or assessment attempt of an
 * enrollment; submitted attempts are immutable history.
 *
 * @property string $id
 * @property string $enrollment_id
 * @property string $kind
 * @property string $evidence_ref
 * @property string $lifecycle_state
 */
final class AssessmentAttempt extends Model
{
    public $incrementing = false;

    protected $keyType = 'string';

    protected $fillable = ['id', 'enrollment_id', 'kind', 'evidence_ref', 'lifecycle_state', 'recorded_by'];
}
