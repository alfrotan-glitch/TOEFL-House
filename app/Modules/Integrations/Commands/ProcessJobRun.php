<?php

declare(strict_types=1);

namespace App\Modules\Integrations\Commands;

use App\Modules\Audit\AttemptedOperation;
use App\Modules\Audit\AuditRecorder;
use App\Modules\Integrations\Domain\BackoffPolicy;
use App\Modules\Integrations\Domain\JobCatalog;
use App\Modules\Integrations\Domain\JobHandler;
use App\Modules\Integrations\Models\JobRun;
use App\Support\Authorization\AccessDecision;
use App\Support\Authorization\Actor;
use App\Support\Errors\AuthorizationDenied;
use App\Support\Idempotency\IdempotentExecution;
use Illuminate\Support\Facades\DB;
use Throwable;

/**
 * Executes a job run occurrence: claim under lock (a concurrent worker
 * finds the run claimed, waiting its backoff, or terminal — never two
 * executions), bounded retries with exponential backoff, dead-letter on
 * exhaustion, terminal outcomes immutable. The operator's capability
 * authorizes the work the job performs.
 */
final class ProcessJobRun
{
    public const CAPABILITY = 'integrations.jobs';

    public function __construct(
        private readonly AccessDecision $access,
        private readonly IdempotentExecution $idempotency,
        private readonly AuditRecorder $audit,
        private readonly AttemptedOperation $attemptedOperation,
    ) {}

    /** @return array{run_id: string, status: string, outcome: array<string, mixed>|null} */
    public function process(Actor $actor, JobRun $run, string $idempotencyKey): array
    {
        $payload = hash('sha256', implode('|', ['integrations.job.process', $run->id, $actor->actorId]));

        try {
            return $this->idempotency->execute('integrations.job.process', $idempotencyKey, $payload,
                fn (): array => DB::transaction(function () use ($actor, $run): array {
                    $this->require($actor);

                    /** @var JobRun $locked */
                    $locked = JobRun::query()->whereKey($run->id)->lockForUpdate()->firstOrFail();

                    // replay/concurrency safe: terminal and not-yet-due runs answer without executing
                    if ($locked->status === 'succeeded' || $locked->status === 'dead_letter') {
                        return ['run_id' => $locked->id, 'status' => $locked->status, 'outcome' => $locked->outcome];
                    }
                    if ($locked->next_retry_at !== null && $locked->next_retry_at->isFuture()) {
                        return ['run_id' => $locked->id, 'status' => 'waiting_retry', 'outcome' => null];
                    }

                    $handlerClass = JobCatalog::handlerFor($locked->job_key);
                    /** @var JobHandler $handler */
                    $handler = app($handlerClass);
                    $attempts = $locked->attempts + 1;

                    try {
                        $outcome = $handler->handle([
                            'run_id' => $locked->id,
                            'job_key' => $locked->job_key,
                            'run_key' => $locked->run_key,
                            'run_by' => $locked->run_by,
                            'attempt' => $attempts,
                        ]);
                        $locked->forceFill(['status' => 'succeeded', 'attempts' => $attempts, 'outcome' => $outcome, 'started_at' => $locked->started_at ?? now(), 'finished_at' => now(), 'last_error' => null]);
                        $locked->save();
                        $this->audit->record($actor->actorId, 'integrations.job.succeeded', 'job_run', $locked->id, null, ['job_key' => $locked->job_key, 'attempt' => $attempts]);

                        return ['run_id' => $locked->id, 'status' => 'succeeded', 'outcome' => $outcome];
                    } catch (Throwable $failure) {
                        $boundedOut = $attempts >= $locked->max_attempts;
                        if ($boundedOut) {
                            $locked->forceFill(['status' => 'dead_letter', 'attempts' => $attempts, 'last_error' => $failure->getMessage(), 'started_at' => $locked->started_at ?? now(), 'finished_at' => now(), 'next_retry_at' => null]);
                            $locked->save();
                            $this->audit->record($actor->actorId, 'integrations.job.dead_letter', 'job_run', $locked->id, null, ['job_key' => $locked->job_key, 'attempt' => $attempts, 'error' => $failure->getMessage()]);

                            return ['run_id' => $locked->id, 'status' => 'dead_letter', 'outcome' => null];
                        }

                        $delayMinutes = BackoffPolicy::delayForAttempt($attempts);
                        $locked->forceFill(['status' => 'failed', 'attempts' => $attempts, 'last_error' => $failure->getMessage(), 'started_at' => $locked->started_at ?? now(), 'next_retry_at' => now()->addMinutes($delayMinutes)]);
                        $locked->save();

                        return ['run_id' => $locked->id, 'status' => 'failed', 'outcome' => null];
                    }
                }),
            );
        } catch (AuthorizationDenied $denial) {
            $this->attemptedOperation->deniedByActor($denial, $actor, 'integrations.job.process', 'job_run', $run->id);
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
