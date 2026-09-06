<?php

declare(strict_types=1);

namespace App\Modules\Finance\Models;

use Illuminate\Database\Eloquent\Model;

/**
 * Finance-approved, scoped exception that can cover an enrollment financial
 * gate remainder. Immutable after approval; the effectiveness window decides
 * when it applies.
 *
 * @property string $id
 * @property string $student_id
 * @property string|null $offering_id
 * @property string|null $class_id
 * @property string $amount
 * @property string $reason
 * @property string $effective_from
 * @property string|null $effective_to
 * @property string $lifecycle_state
 * @property string $requested_by
 * @property string|null $approved_by
 */
final class FinancialGateException extends Model
{
    public const STATE_PROPOSED = 'proposed';

    public const STATE_APPROVED = 'approved';

    public $incrementing = false;

    protected $keyType = 'string';

    protected $fillable = [
        'id', 'student_id', 'offering_id', 'class_id', 'amount', 'reason',
        'effective_from', 'effective_to', 'lifecycle_state', 'requested_by',
        'approved_by', 'approved_at',
    ];
}
