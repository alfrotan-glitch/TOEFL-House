<?php

declare(strict_types=1);

namespace App\Modules\Finance\Models;

use Illuminate\Database\Eloquent\Model;

/**
 * Amount owed by a liable party for an approved charge — an immutable
 * posted source fact.
 *
 * @property string $id
 * @property string $period_id
 * @property string $student_id
 * @property string $source
 * @property string $original_amount
 * @property string $reason
 * @property string|null $originating_branch_id
 * @property string|null $current_home_branch_id
 */
final class Obligation extends Model
{
    public $incrementing = false;

    protected $keyType = 'string';

    protected $fillable = ['id', 'period_id', 'student_id', 'source', 'original_amount', 'reason', 'posted_by', 'originating_branch_id', 'current_home_branch_id'];
}
