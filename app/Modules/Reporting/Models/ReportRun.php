<?php

declare(strict_types=1);

namespace App\Modules\Reporting\Models;

use Illuminate\Database\Eloquent\Model;

/**
 * Reproducible report execution pinned to a metric version; immutable
 * history.
 *
 * @property string $id
 * @property string $reproducibility_hash
 * @property string $result
 * @property string|null $organization_id
 * @property 'complete'|'incomplete'|null $completeness
 * @property array<string, mixed>|null $meta
 * @property array<string, mixed> $filters
 */
final class ReportRun extends Model
{
    public $incrementing = false;

    protected $keyType = 'string';

    protected $fillable = ['id', 'metric_version_id', 'period_key', 'scope_type', 'scope_id', 'organization_id', 'filters', 'result', 'completeness', 'meta', 'reproducibility_hash', 'executed_by'];

    protected $casts = ['filters' => 'array', 'meta' => 'array'];
}
