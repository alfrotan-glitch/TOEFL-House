<?php

declare(strict_types=1);

namespace App\Modules\Resources\Models;

use Illuminate\Database\Eloquent\Model;

/**
 * Approved asset disposal — immutable history; requires two distinct approvers. @property string $id @property string $asset_id @property string $method
 */
final class AssetDisposal extends Model
{
    public $incrementing = false;

    protected $keyType = 'string';

    protected $fillable = ['id', 'asset_id', 'method', 'reason', 'disposed_on', 'requested_by', 'approver_one', 'approver_two'];
}
