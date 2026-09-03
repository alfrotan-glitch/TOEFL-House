<?php

declare(strict_types=1);

namespace App\Modules\Academic\Models;

use Illuminate\Database\Eloquent\Model;
use Illuminate\Database\Eloquent\Relations\BelongsTo;

/**
 * Authoritative academic level/version entity (WP-2 F2). An ordered child of
 * exactly one immutable ProgramVersion; level_key and ordinal are unique per
 * version. Levels are additive — a published version's history is never
 * rewritten.
 *
 * @property string $id
 * @property string $program_version_id
 * @property string $level_key
 * @property int $ordinal
 * @property string $title
 * @property string|null $cefr_ref
 * @property string $lifecycle_state
 */
final class ProgramVersionLevel extends Model
{
    public $incrementing = false;

    protected $keyType = 'string';

    protected $fillable = [
        'id', 'program_version_id', 'level_key', 'ordinal', 'title', 'cefr_ref', 'lifecycle_state',
    ];

    /** @return BelongsTo<ProgramVersion, $this> */
    public function programVersion(): BelongsTo
    {
        return $this->belongsTo(ProgramVersion::class);
    }
}
