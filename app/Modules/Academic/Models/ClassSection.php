<?php

declare(strict_types=1);

namespace App\Modules\Academic\Models;

use Illuminate\Database\Eloquent\Model;
use Illuminate\Database\Eloquent\Relations\BelongsTo;
use Illuminate\Database\Eloquent\Relations\HasMany;

/**
 * A named operational delivery group inside a class. Seat accounting remains
 * at class/offering level; a section allows parallel scheduling and allows
 * the timetable to attribute delivery to a specific group.
 *
 * @property string $id
 * @property string $class_id
 * @property string $name
 * @property int $capacity
 * @property string $lifecycle_state
 */
final class ClassSection extends Model
{
    public const STATE_OPEN = 'open';

    public $incrementing = false;

    protected $table = 'class_sections';

    protected $keyType = 'string';

    protected $fillable = ['id', 'class_id', 'name', 'capacity', 'lifecycle_state'];

    /** @return BelongsTo<ClassModel, $this> */
    public function class(): BelongsTo
    {
        return $this->belongsTo(ClassModel::class, 'class_id');
    }

    /** @return HasMany<ClassSession, $this> */
    public function sessions(): HasMany
    {
        return $this->hasMany(ClassSession::class, 'section_id');
    }
}
