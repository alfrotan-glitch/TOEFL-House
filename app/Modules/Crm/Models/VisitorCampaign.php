<?php

declare(strict_types=1);

namespace App\Modules\Crm\Models;

use Illuminate\Database\Eloquent\Model;
use Illuminate\Database\Eloquent\Relations\BelongsTo;
use Illuminate\Database\Eloquent\Relations\HasMany;

/**
 * Marketing campaign a lead is attributed to. Campaigns are acquisition
 * metadata only — they never carry financial truth.
 *
 * @property string $id
 * @property string $key
 * @property string $name
 * @property string|null $source_id
 * @property string $channel
 * @property string $starts_on
 * @property string|null $ends_on
 * @property string $lifecycle_state
 */
final class VisitorCampaign extends Model
{
    public const STATE_ACTIVE = 'active';

    public const STATE_RETIRED = 'retired';

    public $incrementing = false;

    protected $keyType = 'string';

    protected $fillable = ['id', 'key', 'name', 'source_id', 'channel', 'starts_on', 'ends_on', 'lifecycle_state'];

    /** @return BelongsTo<VisitorSource, $this> */
    public function source(): BelongsTo
    {
        return $this->belongsTo(VisitorSource::class);
    }

    /** @return HasMany<Visitor, $this> */
    public function visitors(): HasMany
    {
        return $this->hasMany(Visitor::class);
    }
}
