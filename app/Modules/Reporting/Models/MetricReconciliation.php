<?php

declare(strict_types=1);

namespace App\Modules\Reporting\Models;

use Illuminate\Database\Eloquent\Model;

/**
 * Variance evidence between a reported value and its authoritative
 * source; immutable history.
 *
 * @property string $id
 * @property string $variance
 * @property string $status
 */
final class MetricReconciliation extends Model
{
    public $incrementing = false;

    protected $keyType = 'string';

    protected $fillable = ['id', 'metric_id', 'period_key', 'scope_type', 'scope_id', 'reported_value', 'authoritative_value', 'variance', 'status', 'explanation', 'reconciled_by'];
}
