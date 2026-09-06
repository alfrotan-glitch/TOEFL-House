<?php

declare(strict_types=1);

namespace App\Modules\Reporting\Models;

use Illuminate\Database\Eloquent\Model;

/**
 * Immutable versioned calculation specification; historical reports keep
 * their original definition.
 *
 * @property string $id
 * @property string $metric_id
 * @property int $version_no
 */
final class MetricVersion extends Model
{
    public $incrementing = false;

    protected $keyType = 'string';

    protected $fillable = ['id', 'metric_id', 'version_no', 'calculation_spec', 'effective_from', 'created_by'];
}
