<?php

declare(strict_types=1);

namespace App\Modules\Hr\Models;

use Illuminate\Database\Eloquent\Model;

/**
 * Append-only employment status fact; the current status is the latest row.
 *
 * @property string $id
 * @property string $employment_id
 * @property string $status
 * @property string $effective_from
 * @property string $reason
 * @property string $actor_id
 */
final class EmploymentStatus extends Model
{
    public $incrementing = false;

    protected $keyType = 'string';

    protected $fillable = ['id', 'employment_id', 'status', 'effective_from', 'reason', 'actor_id'];
}
