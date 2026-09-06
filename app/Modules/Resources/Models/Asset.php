<?php

declare(strict_types=1);

namespace App\Modules\Resources\Models;

use Illuminate\Database\Eloquent\Model;

/**
 * Catalog asset with custody history; disposal (approved) closes it.
 * @property string $id
 * @property string $code
 * @property string $lifecycle_state
 * @property string|null $organization_id
 * @property string|null $originating_branch_id
 * @property string $name
 * @property string $category
 * @property string $location
 * @property string $acquired_on
 */
final class Asset extends Model
{
    public $incrementing = false;

    protected $keyType = 'string';

    protected $fillable = ['id', 'organization_id', 'originating_branch_id', 'code', 'name', 'category', 'location', 'acquired_on', 'lifecycle_state'];
}
