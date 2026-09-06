<?php

declare(strict_types=1);

namespace App\Modules\Academic\Models;

use Illuminate\Database\Eloquent\Model;
use Illuminate\Database\Eloquent\Relations\HasMany;

/**
 * Academic program; publication pins immutable versions. Published program
 * history is never silently rewritten.
 *
 * @property string $id
 * @property string $name
 * @property string $lifecycle_state
 */
final class Program extends Model
{
    public $incrementing = false;

    protected $keyType = 'string';

    protected $fillable = ['id', 'name', 'lifecycle_state'];

    /** @return HasMany<ProgramVersion, $this> */
    public function versions(): HasMany
    {
        return $this->hasMany(ProgramVersion::class);
    }
}
