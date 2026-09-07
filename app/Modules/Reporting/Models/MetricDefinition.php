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

    /**
     * `source_owner` is the immutable claim captured when this definition was
     * created. `canonical_source_owner` and lineage fields record the live
     * catalog authority without rewriting an earlier claim.
     *
     * @var list<string>
     */
    protected $fillable = [
        'id', 'key', 'name', 'source_owner', 'canonical_source_owner',
        'period_authority', 'current_version', 'defined_by', 'lineage_status',
        'lineage_basis', 'lineage_recorded_at',
    ];
}
