<?php

declare(strict_types=1);

namespace App\Modules\Crm\Models;

use App\Modules\Identity\Models\Person;
use App\Modules\Organization\Models\Branch;
use Illuminate\Database\Eloquent\Model;
use Illuminate\Database\Eloquent\Relations\BelongsTo;
use Illuminate\Database\Eloquent\Relations\HasMany;
use Illuminate\Database\Eloquent\Relations\HasOne;

/**
 * Visitor / lead record. The front-of-school acquisition unit: who came/told
 * us, from where, what they want, who owns the follow-up, and where in the
 * pipeline they sit. Anonymous leads are first-class (person_id NULL) and are
 * never fabricated to a person. Branch provenance is immutable once assigned.
 *
 * @property string $id
 * @property string $visitor_code
 * @property string|null $person_id
 * @property string|null $source_id
 * @property string|null $campaign_id
 * @property string $full_name
 * @property string|null $phone
 * @property string|null $email
 * @property string $preferred_channel
 * @property string $visitor_type
 * @property string $status
 * @property string|null $rating
 * @property string|null $interest
 * @property string|null $notes
 * @property string|null $assigned_to
 * @property string|null $origin_branch_id
 * @property string $contact_key
 * @property string $created_by
 */
final class Visitor extends Model
{
    public const STATUS_NEW = 'new';

    public const STATUS_CONTACTED = 'contacted';

    public const STATUS_ENGAGED = 'engaged';

    public const STATUS_QUALIFIED = 'qualified';

    public const STATUS_UNQUALIFIED = 'unqualified';

    public const STATUS_CONVERTED = 'converted';

    public const STATUS_LOST = 'lost';

    public const STATUS_ARCHIVED = 'archived';

    public const RATING_HOT = 'hot';

    public const RATING_WARM = 'warm';

    public const RATING_COLD = 'cold';

    /** @return list<string> */
    public static function openStatuses(): array
    {
        return [
            self::STATUS_NEW,
            self::STATUS_CONTACTED,
            self::STATUS_ENGAGED,
            self::STATUS_QUALIFIED,
            self::STATUS_UNQUALIFIED,
        ];
    }

    public $incrementing = false;

    protected $keyType = 'string';

    protected $fillable = [
        'id', 'visitor_code', 'person_id', 'source_id', 'campaign_id', 'full_name', 'phone', 'email',
        'preferred_channel', 'visitor_type', 'status', 'rating', 'interest', 'notes', 'assigned_to',
        'origin_branch_id', 'contact_key', 'created_by', 'updated_by',
    ];

    /** @return BelongsTo<Person, $this> */
    public function person(): BelongsTo
    {
        return $this->belongsTo(Person::class);
    }

    /** @return BelongsTo<VisitorSource, $this> */
    public function source(): BelongsTo
    {
        return $this->belongsTo(VisitorSource::class);
    }

    /** @return BelongsTo<VisitorCampaign, $this> */
    public function campaign(): BelongsTo
    {
        return $this->belongsTo(VisitorCampaign::class);
    }

    /** @return BelongsTo<Person, $this> */
    public function assignee(): BelongsTo
    {
        return $this->belongsTo(Person::class, 'assigned_to');
    }

    /** @return BelongsTo<Branch, $this> */
    public function originBranch(): BelongsTo
    {
        return $this->belongsTo(Branch::class, 'origin_branch_id');
    }

    /** @return HasMany<VisitorInteraction, $this> */
    public function interactions(): HasMany
    {
        return $this->hasMany(VisitorInteraction::class)->orderByDesc('occurred_on')->orderByDesc('created_at');
    }

    /** @return HasMany<VisitorFollowup, $this> */
    public function followups(): HasMany
    {
        return $this->hasMany(VisitorFollowup::class)->orderBy('scheduled_for');
    }

    /** @return HasOne<VisitorConversion, $this> */
    public function conversion(): HasOne
    {
        return $this->hasOne(VisitorConversion::class);
    }

    public function isOpen(): bool
    {
        return in_array($this->status, self::openStatuses(), true);
    }
}
