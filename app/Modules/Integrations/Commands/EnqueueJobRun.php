<?php

declare(strict_types=1);

namespace App\Modules\Integrations\Commands;

use App\Modules\Audit\AttemptedOperation;
use App\Modules\Audit\AuditRecorder;
use App\Modules\Integrations\Models\JobRun;
use App\Modules\Integrations\Models\JobSchedule;
use App\Support\Authorization\AccessDecision;
use App\Support\Authorization\Actor;
use App\Support\Errors\AuthorizationDenied;
use App\Support\Errors\BusinessRejection;
use App\Support\Idempotency\IdempotentExecution;
use App\Support\Identifiers\RandomIdentifier;
use Illuminate\Support\Facades\DB;

/**
 * One durable row per (job, occurrence): concurrent schedulers racing to
 * enqueue the same occurrence collapse onto the existing run — scheduled
 * work can be triggered repeatedly without duplicating execution.
 */
final class EnqueueJobRun
{
    public const CAPABILITY = 'integrations.jobs';

    public function __construct(
        private readonly AccessDecision $access,
        private readonly IdempotentExecution $idempotency,
        private readonly AuditRecorder $audit,
        private readonly AttemptedOperation $attemptedOperation,
    ) {}

    /** @return array{run_id: string, duplicate: bool} */
    public function enqueue(Actor $actor, string $jobKey, string $runKey, string $idempotencyKey): array
    {
        $payload = hash('sha256', implode('|', ['integrations.job.enqueue', $jobKey, $runKey, $actor->actorId]));

        try {
            return $this->idempotency->execute('integrations.job.enqueue', $idempotencyKey, $payload,
                fn (): array => DB::transaction(function () use ($actor, $jobKey, $runKey): array {
                    $this->require($actor);
                    if ($runKey === '') {
                        throw BusinessRejection::forCode('integrations.job_occurrence', 'an enqueue names its occurrence key');
                    }

                    /** @var JobSchedule|null $schedule */
                    $schedule = JobSchedule::query()->where('job_key', $jobKey)->lockForUpdate()->first();
                    if ($schedule === null) {
                        throw BusinessRejection::forCode('integrations.job_unscheduled', 'only registered schedules enqueue runs');
                    }
                    if (! $schedule->enabled) {
                        throw BusinessRejection::forCode('integrations.job_disabled', 'a disabled schedule enqueues nothing');
                    }

                    /** @var JobRun|null $existing */
                    $existing = JobRun::query()->where('job_key', $jobKey)->where('run_key', $runKey)->lockForUpdate()->first();
                    if ($existing !== null) {
                        return ['run_id' => $existing->id, 'duplicate' => true];
                    }

                    $run = JobRun::query()->create([
                        'id' => RandomIdentifier::new(),
                        'job_key' => $jobKey,
                        'run_key' => $runKey,
                        'status' => 'queued',
                        'attempts' => 0,
                        'max_attempts' => 3,
                        'run_by' => $actor->actorId,
                    ]);
                    $this->audit->record($actor->actorId, 'integrations.job.enqueue', 'job_run', $run->id, null, ['job_key' => $jobKey, 'run_key' => $runKey]);

                    return ['run_id' => $run->id, 'duplicate' => false];
                }),
            );
        } catch (AuthorizationDenied $denial) {
            $this->attemptedOperation->deniedByActor($denial, $actor, 'integrations.job.enqueue', 'job_run', $jobKey);
        }
    }

    private function require(Actor $actor): void
    {
        $outcome = $this->access->decide($actor, self::CAPABILITY, null);
        if (! $outcome->allowed) {
            throw AuthorizationDenied::forCode('integrations.jobs_denied', $outcome->reason);
        }
    }
}
