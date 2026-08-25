<?php

declare(strict_types=1);

namespace App\Modules\Students\Models;

use Illuminate\Database\Eloquent\Model;

/**
 * Effective-dated guardian relationship with relationship-specific
 * permissions. Verification is required before the permissions carry any
 * authority; revocation retains history.
 *
 * @property string $id
 * @property string $student_id
 * @property string $guardian_person_id
 * @property string $relationship
 * @property array<int, string> $permissions
 * @property string $verification_state
 * @property string $lifecycle_state
 * @property string $effective_from
 * @property string|null $effective_to
 */
final class GuardianRelationship extends Model
{
    public $incrementing = false;

    protected $keyType = 'string';

    protected $fillable = [
        'id', 'student_id', 'guardian_person_id', 'relationship', 'permissions',
        'verification_state', 'lifecycle_state', 'effective_from', 'effective_to', 'recorded_by',
    ];

    /** @return array<string, string> */
    protected function casts(): array
    {
        return ['permissions' => 'array'];
    }
}
