<?php

declare(strict_types=1);

namespace App\Modules\Academic\Models;

use Illuminate\Database\Eloquent\Model;

/**
 * Staged assessment-result correction: a proposal is born 'proposed' (a
 * moderator session) and only an approver session (a different person)
 * closes it — approval closes the original result as 'corrected' and
 * records the new released result with the corrects_id link.
 *
 * @property string $id
 * @property string $result_id
 * @property string $score
 * @property string $reason
 * @property string $lifecycle_state
 * @property string $proposed_by
 * @property string|null $approved_by
 */
final class ResultCorrection extends Model
{
    public const STATE_PROPOSED = 'proposed';

    public const STATE_APPROVED = 'approved';

    public $incrementing = false;

    protected $keyType = 'string';

    protected $fillable = ['id', 'result_id', 'score', 'reason', 'lifecycle_state', 'proposed_by', 'approved_by'];
}
