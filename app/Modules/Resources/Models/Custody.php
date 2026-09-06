<?php

declare(strict_types=1);

namespace App\Modules\Resources\Models;

use Illuminate\Database\Eloquent\Model;

/**
 * Custodial period of one asset to one custodian; one open custody per asset, history retained. @property string $id @property string $asset_id @property string $custodian_person_id @property string|null $released_on
 */
final class Custody extends Model
{
    public $incrementing = false;

    protected $keyType = 'string';

    protected $fillable = ['id', 'asset_id', 'custodian_person_id', 'assigned_on', 'released_on', 'assigned_by'];
}
