<?php

declare(strict_types=1);

namespace App\Modules\Finance\Models;

use Illuminate\Database\Eloquent\Model;

/**
 * Finance-approved alternative settlement: an agreed installment schedule
 * that can satisfy the enrollment financial gate. Immutable after approval.
 *
 * @property string $id
 * @property string $student_id
 * @property string|null $offering_id
 * @property string $amount
 * @property int $installments_count
 * @property string $first_due_on
 * @property string $schedule_ref
 * @property string $lifecycle_state
 * @property string $requested_by
 * @property string|null $approved_by
 */
final class EnrollmentInstallmentPlan extends Model
{
    public const STATE_PROPOSED = 'proposed';

    public const STATE_APPROVED = 'approved';

    public $incrementing = false;

    protected $keyType = 'string';

    protected $fillable = [
        'id', 'student_id', 'offering_id', 'amount', 'installments_count',
        'first_due_on', 'schedule_ref', 'lifecycle_state', 'requested_by',
        'approved_by', 'approved_at',
    ];

    protected $casts = [
        'installments_count' => 'integer',
    ];
}
