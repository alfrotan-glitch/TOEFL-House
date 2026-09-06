<?php

declare(strict_types=1);

namespace App\Modules\Academic\Models;

use Illuminate\Database\Eloquent\Model;

/**
 * Named academic period; once published, the period definition is not
 * silently rewritten.
 *
 * @property string $id
 * @property string $name
 * @property string $starts_on
 * @property string $ends_on
 * @property string $lifecycle_state
 */
final class AcademicPeriod extends Model
{
    public $incrementing = false;

    protected $keyType = 'string';

    protected $fillable = ['id', 'name', 'starts_on', 'ends_on', 'lifecycle_state'];
}
