<?php

declare(strict_types=1);

namespace App\Modules\Hr\Models;

use Illuminate\Database\Eloquent\Model;

/**
 * Compensation scale catalog entry: the teacher's compensation rank,
 * independent of skill and of academic level. Active or retired, never
 * deleted; contract versions pin one scale and historical payroll keeps
 * its own snapshot.
 *
 * @property string $id
 * @property string $key
 * @property string $name
 * @property int $rank_order
 * @property string $lifecycle_state
 */
final class Scale extends Model
{
    public const STATE_ACTIVE = 'active';

    public const STATE_RETIRED = 'retired';

    public $incrementing = false;

    protected $keyType = 'string';

    protected $fillable = ['id', 'key', 'name', 'rank_order', 'lifecycle_state'];
}
