<?php

declare(strict_types=1);

namespace App\Modules\Reporting\Models;

use Illuminate\Database\Eloquent\Model;

/**
 * Canonical metric catalog entry; versions carry the calculation
 * specification.
 *
 * @property string $id
 * @property string $key
 * @property int $current_version
 */
final class MetricDefinition extends Model
{
    public $incrementing = false;

    protected $keyType = 'string';

    protected $fillable = ['id', 'key', 'name', 'source_owner', 'period_authority', 'current_version', 'defined_by'];
}
