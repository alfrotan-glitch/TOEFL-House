<?php

declare(strict_types=1);

namespace App\Modules\Finance\Models;

use Illuminate\Database\Eloquent\Model;

/**
 * Finance-owned monetary recognition of immutable Payroll source evidence.
 * The originating branch is a snapshot of the employee provenance at
 * recognition time; it is not re-derived from a mutable home designation.
 */
final class PayrollLiabilityFact extends Model
{
    public $incrementing = false;

    protected $table = 'payroll_liability_facts';

    protected $keyType = 'string';

    protected $fillable = [
        'id', 'source_type', 'source_id', 'period_id', 'employment_id', 'originating_branch_id',
        'amount', 'recognized_by', 'correlation_id', 'evidence_ref',
    ];
}
