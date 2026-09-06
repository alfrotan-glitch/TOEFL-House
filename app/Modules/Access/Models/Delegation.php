<?php

declare(strict_types=1);

namespace App\Modules\Access\Models;

use App\Modules\Access\Domain\AccessLifecycle;
use Illuminate\Database\Eloquent\Model;

/**
 * Dated, limited, reasoned temporary authority from one person to another;
 * it expires automatically and never survives revocation.
 *
 * @property string $id
 * @property string $delegator_person_id
 * @property string $delegate_person_id
 * @property string|null $permission
 * @property string|null $scope_type
 * @property string|null $scope_id
 * @property string $lifecycle_state
 * @property string $effective_from
 * @property string $effective_to
 * @property string $reason
 */
final class Delegation extends Model
{
    public $incrementing = false;

    protected $keyType = 'string';

    protected $fillable = [
        'id', 'delegator_person_id', 'delegate_person_id', 'permission', 'scope_type',
        'scope_id', 'lifecycle_state', 'effective_from', 'effective_to', 'reason', 'created_by',
    ];

    public function isActive(): bool
    {
        return $this->lifecycle_state === AccessLifecycle::STATE_ACTIVE;
    }
}
