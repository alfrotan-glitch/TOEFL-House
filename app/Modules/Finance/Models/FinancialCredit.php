<?php

declare(strict_types=1);

namespace App\Modules\Finance\Models;

use Illuminate\Database\Eloquent\Model;

/**
 * Finance-approved student credit/advance that can satisfy an enrollment
 * financial gate. Immutable after approval.
 *
 * @property string $id
 * @property string $student_id
 * @property string $amount
 * @property string $reason
 * @property string $source_ref
 * @property string $lifecycle_state
 * @property string $requested_by
 * @property string|null $approved_by
 */
final class FinancialCredit extends Model
{
    public const STATE_PROPOSED = 'proposed';

    public const STATE_APPROVED = 'approved';

    public $incrementing = false;

    protected $keyType = 'string';

    protected $fillable = [
        'id', 'student_id', 'amount', 'reason', 'source_ref', 'lifecycle_state',
        'requested_by', 'approved_by', 'approved_at',
    ];
}
