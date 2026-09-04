<?php

declare(strict_types=1);

namespace App\Modules\Academic\Models;

use Illuminate\Database\Eloquent\Model;
use Illuminate\Database\Eloquent\Relations\BelongsTo;

/**
 * Scheduled session of a class; attendance facts attach to sessions. A
 * session delivers at most one teaching skill (nullable for sessions
 * scheduled before skill attribution existed; such sessions are never
 * payable volume). A session may optionally target a room and a class
 * section for timetable attribution.
 *
 * @property string $id
 * @property string $class_id
 * @property string|null $skill_id
 * @property string|null $room_id
 * @property string|null $section_id
 * @property string $scheduled_on
 * @property string $starts_at
 * @property string $ends_at
 */
final class ClassSession extends Model
{
    public $incrementing = false;

    protected $keyType = 'string';

    protected $fillable = ['id', 'class_id', 'skill_id', 'room_id', 'section_id', 'scheduled_on', 'starts_at', 'ends_at'];

    /** @return BelongsTo<ClassModel, $this> */
    public function class(): BelongsTo
    {
        return $this->belongsTo(ClassModel::class, 'class_id');
    }

    /** @return BelongsTo<ClassSection, $this> */
    public function section(): BelongsTo
    {
        return $this->belongsTo(ClassSection::class, 'section_id');
    }

    /** @return BelongsTo<AcademicRoom, $this> */
    public function room(): BelongsTo
    {
        return $this->belongsTo(AcademicRoom::class, 'room_id');
    }
}
