<?php

declare(strict_types=1);

namespace App\Modules\Academic\Models;

use Illuminate\Database\Eloquent\Model;

/**
 * Scheduled session of a class; attendance facts attach to sessions. A
 * session delivers at most one teaching skill (nullable for sessions
 * scheduled before skill attribution existed; such sessions are never
 * payable volume).
 *
 * @property string $id
 * @property string $class_id
 * @property string|null $skill_id
 * @property string $scheduled_on
 * @property string $starts_at
 * @property string $ends_at
 */
final class ClassSession extends Model
{
    public $incrementing = false;

    protected $keyType = 'string';

    protected $fillable = ['id', 'class_id', 'skill_id', 'scheduled_on', 'starts_at', 'ends_at'];
}
