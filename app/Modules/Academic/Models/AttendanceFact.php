<?php

declare(strict_types=1);

namespace App\Modules\Academic\Models;

use Illuminate\Database\Eloquent\Model;

/**
 * One append-only attendance fact (or a correction referencing the fact it
 * corrects with a mandatory reason).
 *
 * @property string $id
 * @property string $session_id
 * @property string $enrollment_id
 * @property string $status
 * @property string|null $corrects_id
 * @property string|null $reason
 */
final class AttendanceFact extends Model
{
    public $incrementing = false;

    protected $keyType = 'string';

    protected $fillable = ['id', 'session_id', 'enrollment_id', 'status', 'corrects_id', 'reason', 'recorded_by'];
}
