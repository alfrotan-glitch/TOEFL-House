<?php

declare(strict_types=1);

namespace App\Modules\Crm\Models;

use App\Modules\Admissions\Models\Applicant;
use App\Modules\Identity\Models\Person;
use App\Modules\Students\Models\Student;
use Illuminate\Database\Eloquent\Model;
use Illuminate\Database\Eloquent\Relations\BelongsTo;

/**
 * Immutable trace that a visitor produced an applicant/student (or a
 * documented enquiry). Exactly one conversion per visitor; CRM never creates
 * the downstream entity itself — it records the result of consuming the
 * authoritative Admissions/Students conversions.
 *
 * @property string $id
 * @property string $visitor_id
 * @property string $conversion_type
 * @property string|null $person_id
 * @property string|null $applicant_id
 * @property string|null $student_id
 * @property string $converted_by
 * @property string $converted_at
 * @property string $correlation_id
 */
final class VisitorConversion extends Model
{
    public $incrementing = false;

    protected $keyType = 'string';

    protected $fillable = [
        'id', 'visitor_id', 'conversion_type', 'person_id', 'applicant_id',
        'student_id', 'converted_by', 'converted_at', 'correlation_id',
    ];

    /** @return BelongsTo<Visitor, $this> */
    public function visitor(): BelongsTo
    {
        return $this->belongsTo(Visitor::class);
    }

    /** @return BelongsTo<Person, $this> */
    public function person(): BelongsTo
    {
        return $this->belongsTo(Person::class);
    }

    /** @return BelongsTo<Applicant, $this> */
    public function applicant(): BelongsTo
    {
        return $this->belongsTo(Applicant::class);
    }

    /** @return BelongsTo<Student, $this> */
    public function student(): BelongsTo
    {
        return $this->belongsTo(Student::class);
    }
}
