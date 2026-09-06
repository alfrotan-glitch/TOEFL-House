<?php

declare(strict_types=1);

namespace App\Modules\Payroll\Models;

use Illuminate\Database\Eloquent\Model;

/**
 * Staged termination settlement: a proposal is born 'proposed' (a
 * preparer session) and only an approver session closes it — approval
 * records the immutable FinalSettlement fact (guarded by 000103).
 *
 * @property string $id
 * @property string $employment_id
 * @property string $amount
 * @property string $basis
 * @property string $lifecycle_state
 * @property string $prepared_by
 * @property string|null $approved_by
 */
final class SettlementProposal extends Model
{
    public const STATE_PROPOSED = 'proposed';

    public const STATE_APPROVED = 'approved';

    public $incrementing = false;

    protected $keyType = 'string';

    protected $fillable = ['id', 'employment_id', 'amount', 'basis', 'lifecycle_state', 'prepared_by', 'approved_by'];
}
