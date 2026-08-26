<?php

declare(strict_types=1);

namespace App\Modules\Resources\Models;

use Illuminate\Database\Eloquent\Model;

/**
 * Catalog asset with custody history; disposal (approved) closes it. @property string $id @property string $code @property string $lifecycle_state
 */
final class Asset extends Model
{
    public $incrementing = false;

    protected $keyType = 'string';

    protected $fillable = ['id', 'code', 'name', 'category', 'location', 'acquired_on', 'lifecycle_state'];
}
