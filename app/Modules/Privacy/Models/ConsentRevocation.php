<?php

declare(strict_types=1);

namespace App\Modules\Privacy\Models;

use Illuminate\Database\Eloquent\Model;

/**
 * Recorded withdrawal of consent: who withdrew it, when, in what scope,
 * and with what effect. Append-only like the evidence it protects.
 *
 * @property string $id
 * @property string $consent_id
 * @property string $revoked_by
 * @property string $scope
 * @property string $effect
 */
final class ConsentRevocation extends Model
{
    public $incrementing = false;

    protected $keyType = 'string';

    protected $fillable = ['id', 'consent_id', 'revoked_by', 'scope', 'effect'];
}
