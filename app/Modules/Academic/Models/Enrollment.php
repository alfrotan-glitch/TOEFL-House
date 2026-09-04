<?php

declare(strict_types=1);

namespace App\Modules\Academic\Models;

use App\Modules\Academic\Placement\Models\AcademicEligibilitySnapshot;
use Illuminate\Database\Eloquent\Model;
use Illuminate\Database\Eloquent\Relations\BelongsTo;

/**
 * Student membership in a class through its lifecycle; transfer closes the
 * old row and opens a new one — never a duplicate active seat.
 *
 * @property string $id
 * @property string $student_id
 * @property string $class_id
 * @property string $lifecycle_state
 * @property string|null $originating_branch_id
 * @property string|null $current_home_branch_id
 * @property string|null $offering_id
 * @property string|null $academic_eligibility_snapshot_id
 * @property string|null $state_reason
 * @property string|null $completion_basis
 * @property string|null $completion_evidence_kind
 * @property string|null $completion_evidence_id
 */
final class Enrollment extends Model
{
    public $incrementing = false;

    protected $keyType = 'string';

    protected $fillable = ['id', 'student_id', 'class_id', 'lifecycle_state', 'originating_branch_id', 'current_home_branch_id', 'offering_id', 'academic_eligibility_snapshot_id', 'financial_gate_evidence', 'financial_gate_evidence_sha256', 'financial_gate_signature', 'financial_gate_assessed_at', 'financial_gate_satisfied', 'state_reason', 'completion_basis', 'completion_evidence_kind', 'completion_evidence_id'];

    protected $casts = [
        'financial_gate_evidence' => 'array',
        'financial_gate_satisfied' => 'boolean',
    ];

    /** @return BelongsTo<Offering, $this> */
    public function offering(): BelongsTo
    {
        return $this->belongsTo(Offering::class);
    }

    /** @return BelongsTo<ClassModel, $this> */
    public function class(): BelongsTo
    {
        return $this->belongsTo(ClassModel::class, 'class_id');
    }

    /** @return BelongsTo<AcademicEligibilitySnapshot, $this> */
    public function eligibilitySnapshot(): BelongsTo
    {
        return $this->belongsTo(AcademicEligibilitySnapshot::class, 'academic_eligibility_snapshot_id');
    }
}
