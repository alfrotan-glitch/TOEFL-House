<?php

declare(strict_types=1);

namespace App\Modules\Reporting\Models;

use Illuminate\Database\Eloquent\Model;

/**
 * A named collection of pinned registered metric slices; no independent
 * truth.
 *
 * @property string $id
 * @property string $name
 */
final class Dashboard extends Model
{
    public $incrementing = false;

    protected $keyType = 'string';

    protected $fillable = ['id', 'name', 'created_by'];
}
