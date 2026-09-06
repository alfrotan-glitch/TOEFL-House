<?php

declare(strict_types=1);

namespace App\Modules\Finance\Models;

use Illuminate\Database\Eloquent\Model;

/**
 * Balanced accounting record; posted journals are immutable, corrections
 * append reversals.
 *
 * @property string $id
 * @property string $period_id
 * @property string $source_type
 * @property string|null $source_id
 * @property string $reason
 */
final class Journal extends Model
{
    public $incrementing = false;

    protected $keyType = 'string';

    protected $fillable = ['id', 'period_id', 'source_type', 'source_id', 'reason', 'posted_by'];
}
