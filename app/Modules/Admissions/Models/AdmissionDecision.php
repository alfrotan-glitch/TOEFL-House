<?php

declare(strict_types=1);

namespace App\Modules\Admissions\Models;

use Illuminate\Database\Eloquent\Model;

/**
 * Recorded admission outcome with reason, evidence, and the three-role
 * authority chain. Append-only: prior decisions are retained.
 *
 * @property string $id
 * @property string $applicant_id
 * @property string $outcome
 * @property string $reason
 * @property string $evidence_ref
 * @property string $initiator_id
 * @property string $reviewer_id
 * @property string $approver_id
 */
final class AdmissionDecision extends Model
{
    public $incrementing = false;

    protected $keyType = 'string';

    protected $fillable = ['id', 'applicant_id', 'outcome', 'reason', 'evidence_ref', 'initiator_id', 'reviewer_id', 'approver_id'];
}
