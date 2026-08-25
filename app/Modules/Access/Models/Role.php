<?php

declare(strict_types=1);

namespace App\Modules\Access\Models;

use Illuminate\Database\Eloquent\Model;

/**
 * Named role whose permissions are published as effective-dated policy
 * versions; active history is never rewritten.
 *
 * @property string $id
 * @property string $name
 */
final class Role extends Model
{
    public $incrementing = false;

    protected $keyType = 'string';

    protected $fillable = ['id', 'name'];
}
