<?php

declare(strict_types=1);

namespace App\Modules\Access\Models;

use Illuminate\Database\Eloquent\Model;

/**
 * Staged organization-wide scope grant request (000116): born
 * 'requested', signed by two distinct approver sessions, and executed once
 * approved. Immutable history — see the 000116 guard.
 *
 * @property string $id
 * @property string $person_id
 * @property string $permission
 * @property string $organization_id
 * @property bool $is_emergency
 * @property string $effective_from
 * @property string|null $effective_to
 * @property string $lifecycle_state
 * @property string $requested_by
 * @property string|null $approver_one_id
 * @property string|null $approver_two_id
 * @property string|null $granted_by
 * @property string|null $grant_id
 */
final class OrgWideGrantRequest extends Model
{
    public $incrementing = false;

    protected $keyType = 'string';

    protected $fillable = [
        'id', 'person_id', 'permission', 'organization_id', 'is_emergency',
        'effective_from', 'effective_to', 'lifecycle_state', 'requested_by',
        'approver_one_id', 'approver_two_id', 'granted_by', 'grant_id',
    ];
}
