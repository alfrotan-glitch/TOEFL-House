<?php

declare(strict_types=1);

namespace App\Modules\Finance\Models;

use Illuminate\Database\Eloquent\Model;

/**
 * The bridge from an opening entry to the certified financial instrument
 * its approval materialized (obligation for receivables, journal for
 * cash positions) — reproducible opening position.
 *
 * @property string $id
 * @property string $instrument_type
 */
final class OpeningMaterialization extends Model
{
    public $incrementing = false;

    protected $keyType = 'string';

    protected $fillable = ['id', 'opening_entry_id', 'instrument_type', 'instrument_id'];
}
