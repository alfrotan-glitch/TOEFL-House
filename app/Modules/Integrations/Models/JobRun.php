<?php

declare(strict_types=1);

namespace App\Modules\Integrations\Models;

use Illuminate\Database\Eloquent\Model;

/**
 * One durable execution of a scheduled job occurrence: identity (job,
 * occurrence) unique, execution progress mutable, terminal outcomes
 * immutable.
 *
 * @property string $id
 * @property string $status
 * @property array<string, mixed>|null $outcome
 */
final class JobRun extends Model
{
    public $incrementing = false;

    protected $keyType = 'string';

    protected $fillable = ['id', 'job_key', 'run_key', 'status', 'attempts', 'max_attempts', 'run_by', 'last_error', 'outcome', 'next_retry_at', 'started_at', 'finished_at'];

    protected $casts = ['outcome' => 'array', 'next_retry_at' => 'datetime', 'started_at' => 'datetime', 'finished_at' => 'datetime'];
}
