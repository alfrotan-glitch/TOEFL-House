<?php

declare(strict_types=1);

namespace App\Modules\Hr\Models;

use Illuminate\Database\Eloquent\Model;

/**
 * Requested and approved absence with history retained; approved leave
 * overlaps are rejected in the domain.
 *
 * @property string $id
 * @property string $employment_id
 * @property string $category
 * @property string $date_from
 * @property string $date_to
 * @property string $lifecycle_state
 */
final class Leave extends Model
{
    public $incrementing = false;

    protected $keyType = 'string';

    protected $fillable = ['id', 'employment_id', 'category', 'date_from', 'date_to', 'reason', 'lifecycle_state', 'requested_by', 'decided_by'];
}
