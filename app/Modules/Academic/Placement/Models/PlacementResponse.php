<?php

declare(strict_types=1);

namespace App\Modules\Academic\Placement\Models;

use Illuminate\Database\Eloquent\Model;
use Illuminate\Database\Eloquent\Relations\BelongsTo;

/**
 * Raw candidate answer/evidence for one question. Append-only immutable
 * evidence; scoring lives on section results, not on this row.
 *
 * @property string $id
 * @property string $attempt_id
 * @property string $question_id
 * @property string $response_value
 * @property bool $tamper_flagged
 * @property string|null $evidence_sha256
 */
final class PlacementResponse extends Model
{
    public $incrementing = false;

    protected $keyType = 'string';

    protected $fillable = ['id', 'attempt_id', 'question_id', 'response_value', 'tamper_flagged', 'evidence_sha256'];

    /** @return BelongsTo<PlacementAttempt, $this> */
    public function attempt(): BelongsTo
    {
        return $this->belongsTo(PlacementAttempt::class, 'attempt_id');
    }

    /** @return BelongsTo<PlacementQuestion, $this> */
    public function question(): BelongsTo
    {
        return $this->belongsTo(PlacementQuestion::class, 'question_id');
    }
}
