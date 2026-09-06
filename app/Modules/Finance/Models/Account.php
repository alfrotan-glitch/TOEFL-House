<?php

declare(strict_types=1);

namespace App\Modules\Finance\Models;

use Illuminate\Database\Eloquent\Model;

/**
 * Chart-of-accounts classification; entries are immutable once defined.
 *
 * @property string $id
 * @property string $code
 * @property string $name
 * @property string $type
 */
final class Account extends Model
{
    public $incrementing = false;

    protected $keyType = 'string';

    protected $fillable = ['id', 'code', 'name', 'type'];
}
