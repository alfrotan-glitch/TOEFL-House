<?php

declare(strict_types=1);

namespace App\Modules\Finance\Models;

use Illuminate\Database\Eloquent\Model;

/**
 * Finance-owned per-case scholarship award: an attributed student benefit
 * decision that binds a student to a funding source (donor) and period under
 * a concrete award rule. It is the aid-package attribution record; monetary
 * application to an obligation line happens through FundAllocation.
 *
 * @property string $id
 * @property string $student_id
 * @property string $funding_source_id
 * @property string $period_id
 * @property numeric-string $amount
 * @property string $award_rule_ref
 * @property string $reason
 * @property string $lifecycle_state
 * @property string $requested_by
 * @property string|null $approved_by
 * @property string|null $approved_at
 */
final class ScholarshipAward extends Model
{
    public const STATE_PROPOSED = 'proposed';

    public const STATE_APPROVED = 'approved';

    public $incrementing = false;

    protected $keyType = 'string';

    protected $fillable = [
        'id', 'student_id', 'funding_source_id', 'period_id', 'amount',
        'award_rule_ref', 'reason', 'lifecycle_state', 'requested_by',
        'approved_by', 'approved_at',
    ];

    protected $casts = [
        'approved_at' => 'datetime',
    ];
}
