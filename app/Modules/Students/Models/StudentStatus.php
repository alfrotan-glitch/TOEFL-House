<?php

declare(strict_types=1);

namespace App\Modules\Students\Models;

use Illuminate\Database\Eloquent\Model;

/**
 * One append-only status period of a student; the open row is the current
 * status and corrections append new rows, never overwrite.
 *
 * @property string $id
 * @property string $student_id
 * @property string $status
 * @property string $effective_from
 * @property string $reason
 */
final class StudentStatus extends Model
{
    public $incrementing = false;

    protected $keyType = 'string';

    protected $fillable = ['id', 'student_id', 'status', 'effective_from', 'reason', 'actor_id'];
}
