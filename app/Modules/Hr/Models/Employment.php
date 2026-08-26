<?php

declare(strict_types=1);

namespace App\Modules\Hr\Models;

use App\Modules\Identity\Models\Person;
use Illuminate\Database\Eloquent\Model;

/**
 * Employment relationship between the organization and a verified person;
 * the current status is the latest append-only status fact.
 *
 * @property string $id
 * @property string $person_id
 * @property string $lifecycle_state
 */
final class Employment extends Model
{
    public $incrementing = false;

    protected $keyType = 'string';

    protected $fillable = ['id', 'person_id', 'lifecycle_state'];
}
