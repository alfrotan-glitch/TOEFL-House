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
use App\Support\Errors\BusinessRejection;
use App\Support\Idempotency\IdempotentExecution;
use Illuminate\Support\Facades\DB;
use Throwable;

/**
 * At-least-once job runner. It commits a processing lease before invoking a
 * handler, then finalizes the durable run under a fresh lock. This prevents
 * a scheduled handler (including network delivery or the domain-event relay)
 * from holding the JobRun transaction open across external or long-running
 * work. Handlers receive the stable run_by actor and must remain idempotent.
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
                fn (): array => $this->executeClaimed($actor, (string) $run->id),
            );
        } catch (AuthorizationDenied $denial) {
            $this->attemptedOperation->deniedByActor($denial, $actor, 'integrations.job.process', 'job_run', $run->id);
        }
    }

    /** @return array{run_id: string, status: string, outcome: array<string, mixed>|null} */
    private function executeClaimed(Actor $actor, string $runId): array
    {
        $claim = DB::transaction(function () use ($actor, $runId): array {
            $this->require($actor);

            /** @var JobRun|null $locked */
            $locked = JobRun::query()->whereKey($runId)->lockForUpdate()->first();
            if ($locked === null) {
                throw BusinessRejection::forCode('integrations.job_missing', 'the job run no longer exists');
            }
            if ($locked->status === 'succeeded' || $locked->status === 'dead_letter') {
                return ['run_id' => $locked->id, 'status' => $locked->status, 'outcome' => $locked->outcome];
            }
            if ($locked->next_retry_at !== null && $locked->next_retry_at->isFuture()) {
                return ['run_id' => $locked->id, 'status' => 'waiting_retry', 'outcome' => null];
            }
            if ($locked->status === 'processing'
                && $locked->lease_until !== null
                && $locked->lease_until->isFuture()) {
                return ['run_id' => $locked->id, 'status' => 'processing', 'outcome' => null];
            }

            $handlerClass = JobCatalog::handlerFor($locked->job_key);
            $attempts = ((int) $locked->attempts) + 1;
            $locked->forceFill([
                'status' => 'processing',
                'attempts' => $attempts,
                'started_at' => $locked->started_at ?? now(),
                'lease_until' => now()->addMinutes(10),
                'next_retry_at' => null,
                'last_error' => null,
            ]);
            $locked->save();

            return [
                'run_id' => (string) $locked->id,
                'job_key' => (string) $locked->job_key,
                'run_key' => (string) $locked->run_key,
                'run_by' => (string) $locked->run_by,
                'attempts' => $attempts,
                'max_attempts' => (int) $locked->max_attempts,
                'handler' => $handlerClass,
            ];
        });

        if (isset($claim['status'])) {
            return $claim;
        }

        try {
            /** @var JobHandler $handler */
            $handler = app($claim['handler']);
            $outcome = $handler->handle([
                'run_id' => $claim['run_id'],
                'job_key' => $claim['job_key'],
                'run_key' => $claim['run_key'],
                'run_by' => $claim['run_by'],
                'attempt' => $claim['attempts'],
            ]);
            return $this->finalizeSuccess($actor, $claim, $outcome);
        } catch (Throwable $failure) {
            return $this->finalizeFailure($actor, $claim, $failure);
        }
    }

    /**
     * @param array<string, mixed> $claim
     * @param array<string, mixed> $outcome
     * @return array{run_id: string, status: string, outcome: array<string, mixed>|null}
     */
    private function finalizeSuccess(Actor $actor, array $claim, array $outcome): array
    {
        return DB::transaction(function () use ($actor, $claim, $outcome): array {
            /** @var JobRun|null $locked */
            $locked = JobRun::query()->whereKey($claim['run_id'])->lockForUpdate()->first();
            if ($locked === null || $locked->status !== 'processing' || (int) $locked->attempts !== (int) $claim['attempts']) {
                return ['run_id' => (string) $claim['run_id'], 'status' => 'stale_claim', 'outcome' => null];
            }
            $locked->forceFill([
                'status' => 'succeeded',
                'outcome' => $outcome,
                'lease_until' => null,
                'finished_at' => now(),
                'last_error' => null,
            ]);
            $locked->save();
            $this->audit->record($actor->actorId, 'integrations.job.succeeded', 'job_run', $locked->id, null, [
                'job_key' => $locked->job_key, 'attempt' => $claim['attempts'],
            ]);

            return ['run_id' => (string) $locked->id, 'status' => 'succeeded', 'outcome' => $outcome];
        });
    }

    /** @param array<string, mixed> $claim
     *  @return array{run_id: string, status: string, outcome: array<string, mixed>|null}
     */
    private function finalizeFailure(Actor $actor, array $claim, Throwable $failure): array
    {
        return DB::transaction(function () use ($actor, $claim, $failure): array {
            /** @var JobRun|null $locked */
            $locked = JobRun::query()->whereKey($claim['run_id'])->lockForUpdate()->first();
            if ($locked === null || $locked->status !== 'processing' || (int) $locked->attempts !== (int) $claim['attempts']) {
                return ['run_id' => (string) $claim['run_id'], 'status' => 'stale_claim', 'outcome' => null];
            }

            $boundedOut = (int) $claim['attempts'] >= (int) $claim['max_attempts'];
            if ($boundedOut) {
                $locked->forceFill([
                    'status' => 'dead_letter',
                    'lease_until' => null,
                    'last_error' => $failure->getMessage(),
                    'finished_at' => now(),
                    'next_retry_at' => null,
                ]);
                $locked->save();
                $this->audit->record($actor->actorId, 'integrations.job.dead_letter', 'job_run', $locked->id, null, [
                    'job_key' => $locked->job_key, 'attempt' => $claim['attempts'], 'error' => $failure->getMessage(),
                ]);

                return ['run_id' => (string) $locked->id, 'status' => 'dead_letter', 'outcome' => null];
            }

            $locked->forceFill([
                'status' => 'failed',
                'lease_until' => null,
                'last_error' => $failure->getMessage(),
                'next_retry_at' => now()->addMinutes(BackoffPolicy::delayForAttempt((int) $claim['attempts'])),
            ]);
            $locked->save();
            $this->audit->record($actor->actorId, 'integrations.job.retry_scheduled', 'job_run', $locked->id, null, [
                'job_key' => $locked->job_key, 'attempt' => $claim['attempts'], 'error' => $failure->getMessage(),
                'next_retry_at' => $locked->next_retry_at?->toIso8601String(),
            ]);

            return ['run_id' => (string) $locked->id, 'status' => 'failed', 'outcome' => null];
        });
    }

    private function require(Actor $actor): void
    {
        $outcome = $this->access->decide($actor, self::CAPABILITY, null);
        if (! $outcome->allowed) {
            throw AuthorizationDenied::forCode('integrations.jobs_denied', $outcome->reason);
        }
    }
}
