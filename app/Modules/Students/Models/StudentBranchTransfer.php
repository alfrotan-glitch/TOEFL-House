<?php

declare(strict_types=1);

namespace App\Modules\Students\Models;

use Illuminate\Database\Eloquent\Model;

/**
 * Append-only student home-branch transfer fact. The immutable
 * originating_branch_id is never rewritten; only current_home_branch_id
 * advances, and every change is retained here.
 *
 * @property string $id
 * @property string $student_id
 * @property string|null $from_branch_id
 * @property string $to_branch_id
 * @property string $effective_from
 * @property string $reason
 * @property string $transferred_by
 */
final class StudentBranchTransfer extends Model
{
    public $incrementing = false;

    protected $keyType = 'string';

    protected $fillable = [
        'id', 'student_id', 'from_branch_id', 'to_branch_id',
        'effective_from', 'reason', 'transferred_by',
    ];
}
