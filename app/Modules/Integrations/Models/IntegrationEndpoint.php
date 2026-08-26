<?php

declare(strict_types=1);

namespace App\Modules\Integrations\Models;

use Illuminate\Database\Eloquent\Model;

/**
 * A registered external system boundary: versioned contract, credential
 * reference (the secret itself lives outside domain data), and lifecycle.
 *
 * @property string $id
 * @property string $key
 * @property string $state
 */
final class IntegrationEndpoint extends Model
{
    public $incrementing = false;

    protected $keyType = 'string';

    protected $fillable = ['id', 'key', 'name', 'channel', 'contract_version', 'credential_ref', 'endpoint_ref', 'state', 'approved_by', 'created_by'];
}
