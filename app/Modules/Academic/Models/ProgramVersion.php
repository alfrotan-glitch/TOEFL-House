<?php

declare(strict_types=1);

namespace App\Modules\Academic\Models;

use Illuminate\Database\Eloquent\Model;
use Illuminate\Database\Eloquent\Relations\BelongsTo;

/**
 * Immutable published version of a program; corrections publish a new
 * version instead of rewriting one.
 *
 * @property string $id
 * @property string $program_id
 * @property int $version_no
 * @property string $summary
 */
final class ProgramVersion extends Model
{
    public $incrementing = false;

    protected $keyType = 'string';

    protected $fillable = ['id', 'program_id', 'version_no', 'summary'];

    /** @return BelongsTo<Program, $this> */
    public function program(): BelongsTo
    {
        return $this->belongsTo(Program::class);
    }
}
