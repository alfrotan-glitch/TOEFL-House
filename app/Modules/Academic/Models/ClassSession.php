<?php

declare(strict_types=1);

namespace App\Modules\Academic\Models;

use Illuminate\Database\Eloquent\Model;

/**
 * Scheduled session of a class; attendance facts attach to sessions.
 *
 * @property string $id
 * @property string $class_id
 * @property string $scheduled_on
 * @property string $starts_at
 * @property string $ends_at
 */
final class ClassSession extends Model
{
    public $incrementing = false;

    protected $keyType = 'string';

    protected $fillable = ['id', 'class_id', 'scheduled_on', 'starts_at', 'ends_at'];
}
