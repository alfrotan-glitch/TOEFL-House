<?php

declare(strict_types=1);

namespace App\Modules\Hr\Models;

use Illuminate\Database\Eloquent\Model;

/**
 * Immutable approved contract version: prepared and submitted by the
 * Finance Manager, approved by the General Manager (never the preparer,
 * never the beneficiary), carrying its own effective window, pinned
 * compensation scale and frozen compensation rules. Approval evidence and
 * digest reproduce exactly what was approved; a change is a new version.
 *
 * @property string $id
 * @property string $contract_id
 * @property int $version_no
 * @property string $lifecycle_state
 * @property string $terms_ref
 * @property string|null $scale_id
 * @property string $effective_from
 * @property string|null $effective_to
 * @property string $prepared_by
 * @property string|null $submitted_at
 * @property string|null $approved_by
 * @property string|null $approved_at
 * @property string|null $approval_digest
 */
final class ContractVersion extends Model
{
    public $incrementing = false;

    protected $keyType = 'string';

    protected $fillable = [
        'id', 'contract_id', 'version_no', 'lifecycle_state', 'terms_ref', 'scale_id',
        'effective_from', 'effective_to', 'prepared_by', 'submitted_at', 'approved_by', 'approved_at', 'approval_digest',
    ];
}
