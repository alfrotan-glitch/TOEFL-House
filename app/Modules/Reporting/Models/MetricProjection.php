<?php

declare(strict_types=1);

namespace App\Modules\Reporting\Models;

use Illuminate\Database\Eloquent\Model;

/**
 * Rebuildable analytical slice with source/version/as-of metadata; the
 * slice identity (version, period, scope) is fixed, the value rebuilds.
 *
 * @property string $id
 * @property string $metric_version_id
 * @property string $period_key
 * @property string $scope_type
 * @property string $value
 * @property string $completeness
 * @property array<string, mixed> $meta
 */
final class MetricProjection extends Model
{
    public $incrementing = false;

    protected $keyType = 'string';

    protected $fillable = ['id', 'metric_version_id', 'period_key', 'scope_type', 'scope_id', 'value', 'completeness', 'meta', 'computed_at', 'computed_by'];

    protected $casts = ['meta' => 'array', 'computed_at' => 'datetime'];
}
