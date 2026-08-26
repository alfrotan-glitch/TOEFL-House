<?php

declare(strict_types=1);

namespace App\Modules\Finance\Models;

use Illuminate\Database\Eloquent\Model;

/**
 * Application of fund money to a student's obligation line — permitted use
 * only (restricted funds stay restricted); immutable history.
 *
 * @property string $id
 * @property string $fund_id
 * @property string $obligation_line_id
 * @property string $amount
 * @property string $reason
 */
final class FundAllocation extends Model
{
    public $incrementing = false;

    protected $keyType = 'string';

    protected $fillable = ['id', 'fund_id', 'obligation_line_id', 'amount', 'reason', 'allocated_by'];
}
