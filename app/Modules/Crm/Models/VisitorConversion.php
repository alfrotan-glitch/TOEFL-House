<?php

declare(strict_types=1);

namespace App\Modules\Crm\Models;

use App\Modules\Admissions\Models\Applicant;
use App\Modules\Audit\Models\AuditEvent;
use App\Modules\Identity\Models\Person;
use App\Modules\Students\Models\Student;
use Illuminate\Database\Eloquent\Model;
use Illuminate\Database\Eloquent\Relations\BelongsTo;
use Illuminate\Database\Eloquent\Relations\HasOne;

/**
 * Immutable trace that an authoritative Admissions/Students workflow produced
 * an applicant/student. Exactly one terminal conversion per visitor; a later
 * Applicant-to-Student handoff is a separate immutable CRM trace. CRM never creates
 * the downstream entity itself — it records the result of consuming the
 * authoritative Admissions/Students conversions.
 *
 * @property string $id
 * @property string $visitor_id
 * @property string $conversion_type
 * @property string $authority
 * @property string|null $person_id
 * @property string|null $applicant_id
 * @property string|null $student_id
 * @property string $converted_by
 * @property string $authority_audit_event_id
 * @property \Carbon\CarbonImmutable $converted_at
 * @property string $correlation_id
 */
final class VisitorConversion extends Model
{
    public $incrementing = false;

    protected $keyType = 'string';

    protected $fillable = [
        'id', 'visitor_id', 'conversion_type', 'authority', 'person_id', 'applicant_id',
        'student_id', 'converted_by', 'authority_audit_event_id', 'converted_at', 'correlation_id',
    ];

    protected $casts = [
        'converted_at' => 'immutable_datetime',
    ];

    /** @return BelongsTo<AuditEvent, $this> */
    public function authorityEvent(): BelongsTo
    {
        return $this->belongsTo(AuditEvent::class, 'authority_audit_event_id');
    }

    /** @return HasOne<VisitorConversionHandoff, $this> */
    public function studentHandoff(): HasOne
    {
        return $this->hasOne(VisitorConversionHandoff::class, 'source_conversion_id');
    }

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
