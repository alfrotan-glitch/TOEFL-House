<?php

declare(strict_types=1);

namespace App\Modules\Hr\Models;

use Illuminate\Database\Eloquent\Model;

/**
 * Work/teaching basis — hours, classes, workload evidence retained as
 * source history (append-only). Academic-sourced evidence that disagrees
 * with employment status is held for review, never dropped.
 *
 * @property string $id
 * @property string $employment_id
 * @property string $source
 * @property string|null $teacher_assignment_id
 * @property string $period_from
 * @property string $period_to
 * @property string $quantity
 * @property string $unit
 * @property string $evidence_ref
 * @property string $lifecycle_state
 */
final class WorkBasis extends Model
{
    public $incrementing = false;

    protected $keyType = 'string';

    protected $fillable = ['id', 'employment_id', 'source', 'teacher_assignment_id', 'period_from', 'period_to', 'quantity', 'unit', 'evidence_ref', 'note', 'lifecycle_state', 'recorded_by'];
}
