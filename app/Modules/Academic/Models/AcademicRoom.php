<?php

declare(strict_types=1);

namespace App\Modules\Academic\Models;

use Illuminate\Database\Eloquent\Model;
use Illuminate\Database\Eloquent\Relations\HasMany;

/**
 * A branch-owned physical room used by the academic timetable.
 *
 * @property string $id
 * @property string $branch_id
 * @property string $name
 * @property string $code
 * @property int $capacity
 * @property string $room_type
 * @property string $lifecycle_state
 */
final class AcademicRoom extends Model
{
    public const STATE_AVAILABLE = 'available';

    public $incrementing = false;

    protected $table = 'academic_rooms';

    protected $keyType = 'string';

    protected $fillable = ['id', 'branch_id', 'name', 'code', 'capacity', 'room_type', 'lifecycle_state'];

    /** @return HasMany<ClassSession, $this> */
    public function sessions(): HasMany
    {
        return $this->hasMany(ClassSession::class, 'room_id');
    }
}
