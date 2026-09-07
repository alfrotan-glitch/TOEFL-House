<?php

declare(strict_types=1);

namespace App\Modules\Finance\Models;

use Illuminate\Database\Eloquent\Model;

/**
 * Append-only revocation of one approved enrollment-gate coverage source.
 *
 * The source and its original obligation commitments remain immutable
 * historical evidence. A recorded revocation only removes that source from
 * future gate assessments, freeing current coverage capacity for a newly
 * evidenced replacement instrument.
 *
 * @property string $id
 * @property string $coverage_source_type
 * @property string $coverage_source_id
 * @property string $student_id
 * @property string $reason
 * @property string $lifecycle_state
 * @property string $requested_by
 * @property string|null $approved_by
 */
final class FinancialCoverageRevocation extends Model
{
    public const STATE_PROPOSED = 'proposed';

    public const STATE_RECORDED = 'recorded';

    public $incrementing = false;

    protected $keyType = 'string';

    protected $fillable = [
        'id', 'coverage_source_type', 'coverage_source_id', 'student_id',
        'reason', 'lifecycle_state', 'requested_by', 'approved_by', 'approved_at',
    ];
}
