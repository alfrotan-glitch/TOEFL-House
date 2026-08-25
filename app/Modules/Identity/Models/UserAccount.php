<?php

declare(strict_types=1);

namespace App\Modules\Identity\Models;

use Illuminate\Database\Eloquent\Model;
use Illuminate\Database\Eloquent\Relations\BelongsTo;

/**
 * Authentication identity owned by the identity module: one active account
 * per verified person, deactivated rather than erased, with the creation and
 * deactivation history kept in audit evidence.
 *
 * @property string $id
 * @property string $person_id
 * @property string $username
 * @property string $account_state
 * @property string|null $deactivated_at
 * @property string|null $deactivation_reason
 */
final class UserAccount extends Model
{
    public const STATE_ACTIVE = 'active';

    public const STATE_DEACTIVATED = 'deactivated';

    public $incrementing = false;

    protected $keyType = 'string';

    protected $fillable = [
        'id', 'person_id', 'username', 'account_state', 'deactivated_at', 'deactivation_reason',
    ];

    public $timestamps = false;

    /** @return BelongsTo<Person, $this> */
    public function person(): BelongsTo
    {
        return $this->belongsTo(Person::class);
    }

    public function isActive(): bool
    {
        return $this->account_state === self::STATE_ACTIVE;
    }
}
