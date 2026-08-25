<?php

declare(strict_types=1);

namespace App\Modules\Identity\Models;

use Illuminate\Database\Eloquent\Model;
use Illuminate\Database\Eloquent\Relations\HasMany;

/**
 * Verified human identity of the person aggregate. Identity key is set once
 * at verification; two verified persons never share it, and a person row is
 * never deleted.
 *
 * @property string $id
 * @property string $legal_name
 * @property string $date_of_birth
 * @property string $verification_state
 * @property string|null $identity_key
 * @property string|null $identity_evidence_ref
 * @property string|null $verified_at
 * @property string|null $verified_by
 */
final class Person extends Model
{
    public const VERIFICATION_UNVERIFIED = 'unverified';

    public const VERIFICATION_VERIFIED = 'verified';

    public $incrementing = false;

    protected $keyType = 'string';

    protected $fillable = [
        'id', 'legal_name', 'date_of_birth', 'verification_state',
        'identity_key', 'identity_evidence_ref', 'verified_at', 'verified_by',
    ];

    public $timestamps = false;

    public function isVerified(): bool
    {
        return $this->verification_state === self::VERIFICATION_VERIFIED;
    }

    /** @return HasMany<UserAccount, $this> */
    public function userAccounts(): HasMany
    {
        return $this->hasMany(UserAccount::class);
    }
}
