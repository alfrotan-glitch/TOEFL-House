<?php

declare(strict_types=1);

namespace App\Modules\Resources\Models;

use Illuminate\Database\Eloquent\Model;

/**
 * Facilities work order: request, approval, progress, completion with evidence. @property string $id @property string $lifecycle_state @property string|null $evidence_ref
 */
final class WorkOrder extends Model
{
    public $incrementing = false;

    protected $keyType = 'string';

    protected $fillable = ['id', 'facility_note', 'description', 'lifecycle_state', 'requested_by', 'approved_by', 'evidence_ref'];
}
