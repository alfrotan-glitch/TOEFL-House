<?php

declare(strict_types=1);

namespace App\Modules\Finance\Models;

use Illuminate\Database\Eloquent\Model;

/**
 * Immutable allocation of one approved enrollment-gate instrument against one
 * concrete student obligation.
 *
 * This is a coverage commitment, not a cash/payment allocation and never
 * changes Finance's monetary balance. It makes the otherwise aggregate gate
 * authorization attributable, scoped, and non-overcommittable while
 * FinancialBalanceQuery remains the only monetary balance authority.
 *
 * @property string $id
 * @property string $coverage_source_type
 * @property string $coverage_source_id
 * @property string $obligation_id
 * @property numeric-string $amount
 */
final class FinancialCoverageCommitment extends Model
{
    public const SOURCE_FINANCIAL_CREDIT = 'financial_credit';

    public const SOURCE_INSTALLMENT_PLAN = 'enrollment_installment_plan';

    public const SOURCE_GATE_EXCEPTION = 'financial_gate_exception';

    public $incrementing = false;

    protected $keyType = 'string';

    protected $fillable = [
        'id', 'coverage_source_type', 'coverage_source_id', 'obligation_id', 'amount',
    ];
}
