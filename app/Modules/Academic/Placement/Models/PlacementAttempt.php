<?php

declare(strict_types=1);

namespace App\Modules\Academic\Placement\Models;

use Illuminate\Database\Eloquent\Model;
use Illuminate\Database\Eloquent\Relations\BelongsTo;
use Illuminate\Database\Eloquent\Relations\HasMany;

/**
 * A server-authoritative placement attempt. Submitted/timed-out attempts
 * are immutable evidence; timing is server-measured and the evidence set is
 * HMAC-protected.
 *
 * @property string $id
 * @property string $profile_id
 * @property string $test_version_id
 * @property string $delivery_mode
 * @property int $attempt_no
 * @property string $status
 * @property string|null $evidence_ref
 * @property string|null $anti_tamper_hmac
 * @property bool $tamper_flagged
 * @property string|null $tamper_reason
 * @property string|null $proctor_person_id
 * @property string|null $originating_branch_id
 * @property string|null $current_home_branch_id
 */
final class PlacementAttempt extends Model
{
    public const STATUS_SCHEDULED = 'scheduled';

    public const STATUS_IN_PROGRESS = 'in_progress';

    public const STATUS_SUBMITTED = 'submitted';

    public const STATUS_TIMED_OUT = 'timed_out';

    public const STATUS_CANCELLED = 'cancelled';

    public $incrementing = false;

    protected $keyType = 'string';

    protected $fillable = [
        'id', 'profile_id', 'test_version_id', 'delivery_mode', 'attempt_no', 'status',
        'started_at', 'ended_at', 'duration_seconds', 'evidence_ref', 'anti_tamper_hmac',
        'tamper_flagged', 'tamper_reason', 'proctor_person_id', 'originating_branch_id',
        'current_home_branch_id', 'correlation_id',
    ];

    /** @return BelongsTo<PlacementProfile, $this> */
    public function profile(): BelongsTo
    {
        return $this->belongsTo(PlacementProfile::class, 'profile_id');
    }

    /** @return HasMany<PlacementResponse, $this> */
    public function responses(): HasMany
    {
        return $this->hasMany(PlacementResponse::class, 'attempt_id');
    }

    /** @return HasMany<PlacementSectionResult, $this> */
    public function sectionResults(): HasMany
    {
        return $this->hasMany(PlacementSectionResult::class, 'attempt_id');
    }
}
