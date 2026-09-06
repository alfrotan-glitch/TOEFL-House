<?php

declare(strict_types=1);

namespace App\Modules\Integrations\Models;

use Illuminate\Database\Eloquent\Model;

/**
 * The durable registration of a scheduled job from the closed job
 * catalog.
 *
 * @property string $id
 * @property string $job_key
 */
final class JobSchedule extends Model
{
    public $incrementing = false;

    protected $keyType = 'string';

    protected $fillable = ['id', 'job_key', 'name', 'schedule_expr', 'enabled', 'created_by'];

    protected $casts = ['enabled' => 'boolean'];
}
