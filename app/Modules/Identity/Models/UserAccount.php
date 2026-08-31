<?php

declare(strict_types=1);

namespace App\Modules\Identity\Models;

use Illuminate\Auth\Authenticatable;
use Illuminate\Contracts\Auth\Authenticatable as AuthenticatableContract;
use Illuminate\Database\Eloquent\Model;
use Illuminate\Database\Eloquent\Relations\BelongsTo;

/**
 * Authentication identity owned by the identity module: one active account
 * per verified person, deactivated rather than erased, with the creation and
 * deactivation history kept in audit evidence. Credentials are stored hashed
 * and set only through the identity command surface; the session authenticates
 * this account, and authority is then resolved from the canonical access
 * model (never carried by the session).
 *
 * @property string $id
 * @property string $person_id
 * @property string $username
 * @property string|null $password_hash
 * @property string|null $remember_token
 * @property string|null $password_changed_at
 * @property string $account_state
 * @property string|null $deactivated_at
 * @property string|null $deactivation_reason
 */
final class UserAccount extends Model implements AuthenticatableContract
{
    use Authenticatable;

    public const STATE_ACTIVE = 'active';

    public const STATE_DEACTIVATED = 'deactivated';

    public $incrementing = false;

    protected $keyType = 'string';

    protected $fillable = [
        'id', 'person_id', 'username', 'password_hash', 'password_changed_at',
        'account_state', 'deactivated_at', 'deactivation_reason',
    ];

    public $timestamps = false;

    /** The credential column is named for its purpose in the domain. */
    public function getAuthPasswordName(): string
    {
        return 'password_hash';
    }

    /** A deactivated account can never authenticate. */
    public function canAuthenticate(): bool
    {
        return $this->account_state === self::STATE_ACTIVE && $this->password_hash !== null;
    }

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
