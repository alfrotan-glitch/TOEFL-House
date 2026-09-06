<?php

declare(strict_types=1);

namespace App\Modules\Resources\Models;

use Illuminate\Database\Eloquent\Model;

/**
 * Facilities work order with immutable originating branch/organization provenance: request, approval, progress, completion with evidence.
 * @property string $id
 * @property string|null $organization_id
 * @property string|null $originating_branch_id
 * @property string $lifecycle_state
 * @property string|null $evidence_ref
 * @property string $facility_note
 * @property string $description
 * @property string $requested_by
 * @property string $approved_by
 */
final class WorkOrder extends Model
{
    public $incrementing = false;

    protected $keyType = 'string';

    protected $fillable = ['id', 'organization_id', 'originating_branch_id', 'facility_note', 'description', 'lifecycle_state', 'requested_by', 'approved_by', 'evidence_ref'];
}
