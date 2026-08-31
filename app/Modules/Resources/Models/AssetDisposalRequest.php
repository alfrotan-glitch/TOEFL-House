<?php

declare(strict_types=1);

namespace App\Modules\Resources\Models;

use Illuminate\Database\Eloquent\Model;

/**
 * Staged asset disposal request (000115): born 'requested', signed by two
 * distinct approver sessions in their own sessions, and executed by the
 * requesting session once approved. Immutable history — see the 000115 guard.
 *
 * @property string $id
 * @property string $asset_id
 * @property string $method
 * @property string $reason
 * @property string $lifecycle_state
 * @property string $requested_by
 * @property string|null $approver_one_id
 * @property string|null $approver_two_id
 * @property string|null $executed_by
 * @property string|null $disposal_id
 */
final class AssetDisposalRequest extends Model
{
    public $incrementing = false;

    protected $keyType = 'string';

    protected $fillable = [
        'id', 'asset_id', 'method', 'reason', 'lifecycle_state', 'requested_by',
        'approver_one_id', 'approver_two_id', 'executed_by', 'disposal_id',
    ];
}
