<?php

declare(strict_types=1);

namespace App\Modules\Finance\Models;

use Illuminate\Database\Eloquent\Model;

/**
 * Atomic charge within an obligation; immutable.
 *
 * @property string $id
 * @property string $obligation_id
 * @property string $category
 * @property string $amount
 * @property string $source_ref
 */
final class ObligationLine extends Model
{
    public $incrementing = false;

    protected $keyType = 'string';

    protected $fillable = ['id', 'obligation_id', 'category', 'amount', 'source_ref'];
}
