<?php

declare(strict_types=1);

namespace App\Modules\Access\Models;

use App\Modules\Access\Domain\AccessLifecycle;
use Illuminate\Database\Eloquent\Model;

/**
 * Named-scope permission grant to a person. Emergency grants are limited,
 * dated, and flagged for mandatory review; all grants expire or are
 * revoked, never deleted.
 *
 * @property string $id
 * @property string $person_id
 * @property string $permission
 * @property string $scope_type
 * @property string $scope_id
 * @property string $lifecycle_state
 * @property string $effective_from
 * @property string|null $effective_to
 * @property bool $is_emergency
 * @property bool $review_required
 */
final class ScopeGrant extends Model
{
    public $incrementing = false;

    protected $keyType = 'string';

    protected $fillable = [
        'id', 'person_id', 'permission', 'scope_type', 'scope_id', 'lifecycle_state',
        'effective_from', 'effective_to', 'is_emergency', 'review_required', 'granted_by',
    ];

    public function isEmergency(): bool
    {
        return $this->is_emergency;
    }

    public function isActive(): bool
    {
        return $this->lifecycle_state === AccessLifecycle::STATE_ACTIVE;
    }
}
