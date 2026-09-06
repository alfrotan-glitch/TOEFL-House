<?php

declare(strict_types=1);

namespace App\Modules\Crm\Models;

use App\Modules\Audit\Models\AuditEvent;
use App\Modules\Identity\Models\Person;
use App\Modules\Students\Models\Student;
use Illuminate\Database\Eloquent\Model;
use Illuminate\Database\Eloquent\Relations\BelongsTo;

/**
 * Immutable CRM evidence of the later Applicant -> Student handoff. The
 * original applicant conversion remains intact; CRM stores only this
 * downstream trace and never creates or changes the Student.
 *
 * @property string $id
 * @property string $source_conversion_id
 * @property string $visitor_id
 * @property string $student_id
 * @property string $person_id
 * @property string $authority_audit_event_id
 * @property string $converted_by
 * @property string $converted_at
 * @property string $correlation_id
 */
final class VisitorConversionHandoff extends Model
{
    public $incrementing = false;

    protected $keyType = 'string';

    protected $fillable = [
        'id', 'source_conversion_id', 'visitor_id', 'student_id', 'person_id',
        'authority_audit_event_id', 'converted_by', 'converted_at', 'correlation_id',
    ];

    protected $casts = [
        'converted_at' => 'immutable_datetime',
    ];

    /** @return BelongsTo<VisitorConversion, $this> */
    public function sourceConversion(): BelongsTo
    {
        return $this->belongsTo(VisitorConversion::class, 'source_conversion_id');
    }

    /** @return BelongsTo<Visitor, $this> */
    public function visitor(): BelongsTo
    {
        return $this->belongsTo(Visitor::class);
    }

    /** @return BelongsTo<Student, $this> */
    public function student(): BelongsTo
    {
        return $this->belongsTo(Student::class);
    }

    /** @return BelongsTo<Person, $this> */
    public function person(): BelongsTo
    {
        return $this->belongsTo(Person::class);
    }

    /** @return BelongsTo<AuditEvent, $this> */
    public function authorityAuditEvent(): BelongsTo
    {
        return $this->belongsTo(AuditEvent::class, 'authority_audit_event_id');
    }

    /** @return BelongsTo<Person, $this> */
    public function converter(): BelongsTo
    {
        return $this->belongsTo(Person::class, 'converted_by');
    }
}
