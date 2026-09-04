<?php

declare(strict_types=1);

namespace App\Modules\Crm\Models;

use Illuminate\Database\Eloquent\Model;
use Illuminate\Database\Eloquent\Relations\HasMany;

/**
 * Acquisition source catalog — where a visitor/lead came from.
 *
 * @property string $id
 * @property string $key
 * @property string $name
 * @property string|null $category
 * @property string $lifecycle_state
 */
final class VisitorSource extends Model
{
    public const STATE_ACTIVE = 'active';

    public const STATE_RETIRED = 'retired';

    public $incrementing = false;

    protected $keyType = 'string';

    protected $fillable = ['id', 'key', 'name', 'category', 'lifecycle_state'];

    /** @return HasMany<VisitorCampaign, $this> */
    public function campaigns(): HasMany
    {
        return $this->hasMany(VisitorCampaign::class);
    }

    /** @return HasMany<Visitor, $this> */
    public function visitors(): HasMany
    {
        return $this->hasMany(Visitor::class);
    }
}
