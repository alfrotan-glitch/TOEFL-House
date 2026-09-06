<?php

declare(strict_types=1);

namespace App\Modules\Finance\Models;

use Illuminate\Database\Eloquent\Model;

/**
 * Finance-owned immutable termination settlement. Payroll may prepare the
 * proposed amount and evidence, but this is the authoritative recorded
 * financial fact after Finance approval.
 */
final class EmploymentSettlement extends Model
{
    public $incrementing = false;

    protected $keyType = 'string';

    protected $fillable = [
        'id', 'employment_id', 'proposal_id', 'amount', 'basis', 'prepared_by', 'approved_by',
    ];
}
