<?php

declare(strict_types=1);

namespace App\Modules\Students\Models;

use Illuminate\Database\Eloquent\Model;
use Illuminate\Database\Eloquent\Relations\HasMany;

/**
 * Student identity: exactly one per person, created only from an approved
 * admission decision inside the conversion transaction. Status lives in
 * append-only history rows.
 *
 * @property string $id
 * @property string $person_id
 * @property string $admission_decision_id
 * @property string $student_code
 */
final class Student extends Model
{
    public $incrementing = false;

    protected $keyType = 'string';

    protected $fillable = ['id', 'person_id', 'admission_decision_id', 'student_code'];

    /** @return HasMany<StudentStatus, $this> */
    public function statuses(): HasMany
    {
        return $this->hasMany(StudentStatus::class);
    }
}
