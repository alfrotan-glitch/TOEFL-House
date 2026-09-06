<?php

declare(strict_types=1);

namespace App\Modules\Academic\Models;

use App\Modules\Students\Models\Student;
use Illuminate\Database\Eloquent\Model;
use Illuminate\Database\Eloquent\Relations\BelongsTo;

/**
 * Ordered class waitlist request. A student holds at most one open entry per
 * class; positions are unique among open entries. Promotion creates a normal
 * requested enrollment; the waitlist row itself is never a seat.
 *
 * @property string $id
 * @property string $class_id
 * @property string $student_id
 * @property string|null $offering_id
 * @property int $position
 * @property string $lifecycle_state
 * @property string $joined_by
 */
final class ClassWaitlistEntry extends Model
{
    public const STATE_WAITING = 'waiting';

    public const STATE_OFFERED = 'offered';

    public const STATE_ENROLLED = 'enrolled';

    public const STATE_WITHDRAWN = 'withdrawn';

    public const STATE_EXPIRED = 'expired';

    public $incrementing = false;

    protected $keyType = 'string';

    protected $fillable = [
        'id', 'class_id', 'student_id', 'offering_id', 'position', 'lifecycle_state', 'joined_by',
    ];

    /** @return BelongsTo<ClassModel, $this> */
    public function class(): BelongsTo
    {
        return $this->belongsTo(ClassModel::class, 'class_id');
    }

    /** @return BelongsTo<Student, $this> */
    public function student(): BelongsTo
    {
        return $this->belongsTo(Student::class);
    }

    /** @return BelongsTo<Offering, $this> */
    public function offering(): BelongsTo
    {
        return $this->belongsTo(Offering::class);
    }
}
