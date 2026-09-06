<?php

declare(strict_types=1);

namespace App\Modules\Academic\Models;

use Illuminate\Database\Eloquent\Model;

/**
 * Teaching skill catalog entry (what is taught, independent of academic
 * level): active or retired, never deleted; payroll and compensation rules
 * reference skills by identity, never by free text.
 *
 * @property string $id
 * @property string $key
 * @property string $name
 * @property string $lifecycle_state
 */
final class Skill extends Model
{
    public const STATE_ACTIVE = 'active';

    public const STATE_RETIRED = 'retired';

    public $incrementing = false;

    protected $keyType = 'string';

    protected $fillable = ['id', 'key', 'name', 'lifecycle_state'];
}
