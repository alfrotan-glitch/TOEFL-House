<?php

declare(strict_types=1);

namespace App\Modules\Finance\Models;

use Illuminate\Database\Eloquent\Model;

/**
 * Comparison of expected and observed state with recorded variance —
 * evidence, never an alternate cash truth; locks on approval.
 *
 * @property string $id
 * @property string $period_id
 * @property string $subject
 * @property string $expected
 * @property string $observed
 * @property string $variance
 * @property string $lifecycle_state
 */
final class Reconciliation extends Model
{
    public $incrementing = false;

    protected $keyType = 'string';

    protected $fillable = ['id', 'period_id', 'subject', 'expected', 'observed', 'variance', 'explanation', 'lifecycle_state', 'observed_by', 'approved_by'];
}
