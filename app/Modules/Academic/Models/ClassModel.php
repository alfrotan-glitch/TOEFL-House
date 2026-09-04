<?php

declare(strict_types=1);

namespace App\Modules\Academic\Models;

use Illuminate\Database\Eloquent\Model;
use Illuminate\Database\Eloquent\Relations\HasMany;

/**
 * A class delivering one published program version inside one published
 * period with a fixed capacity.
 *
 * @property string $id
 * @property string $program_version_id
 * @property string $period_id
 * @property int $capacity
 * @property string $lifecycle_state
 * @property string|null $program_version_level_id
 */
final class ClassModel extends Model
{
    public $incrementing = false;

    protected $table = 'classes';

    protected $keyType = 'string';

    protected $fillable = ['id', 'program_version_id', 'period_id', 'capacity', 'lifecycle_state', 'program_version_level_id'];

    /** @return HasMany<Enrollment, $this> */
    public function enrollments(): HasMany
    {
        return $this->hasMany(Enrollment::class, 'class_id');
    }

    /** @return HasMany<ClassWaitlistEntry, $this> */
    public function waitlistEntries(): HasMany
    {
        return $this->hasMany(ClassWaitlistEntry::class, 'class_id');
    }

    /** @return HasMany<ClassSection, $this> */
    public function sections(): HasMany
    {
        return $this->hasMany(ClassSection::class, 'class_id');
    }

    /** @return HasMany<ClassSession, $this> */
    public function sessions(): HasMany
    {
        return $this->hasMany(ClassSession::class, 'class_id');
    }
}
