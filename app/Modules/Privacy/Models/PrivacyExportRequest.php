<?php

declare(strict_types=1);

namespace App\Modules\Privacy\Models;

use Illuminate\Database\Eloquent\Model;

/**
 * Staged organization-wide data export request: requested by an
 * exporter, signed by two distinct approvers in their own sessions, and
 * executed once approved. Immutable history — see the 000114 guard.
 *
 * @property string $id
 * @property string $subject_person_id
 * @property string $purpose
 * @property string $organization_id
 * @property string $lifecycle_state
 * @property string $requested_by
 * @property string|null $approver_one_id
 * @property string|null $approver_two_id
 * @property string|null $exported_by
 * @property string|null $disclosure_id
 */
final class PrivacyExportRequest extends Model
{
    public $incrementing = false;

    protected $keyType = 'string';

    protected $fillable = [
        'id', 'subject_person_id', 'purpose', 'organization_id', 'lifecycle_state',
        'requested_by', 'approver_one_id', 'approver_two_id', 'exported_by', 'disclosure_id',
    ];
}
