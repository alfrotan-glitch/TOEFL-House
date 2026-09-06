<?php

declare(strict_types=1);

namespace App\Modules\Integrations\Commands;

use App\Modules\Audit\AttemptedOperation;
use App\Modules\Audit\AuditRecorder;
use App\Modules\Integrations\Domain\JobCatalog;
use App\Modules\Integrations\Models\JobSchedule;
use App\Support\Authorization\AccessDecision;
use App\Support\Authorization\Actor;
use App\Support\Errors\AuthorizationDenied;
use App\Support\Errors\BusinessRejection;
use App\Support\Idempotency\IdempotentExecution;
use App\Support\Identifiers\RandomIdentifier;
use Illuminate\Support\Facades\DB;

/**
 * Scheduled work is registered configuration: only catalog jobs, one
 * schedule per job key, enable/disable is reversible, history retained.
 */
final class RegisterJob
{
    public const CAPABILITY = 'integrations.jobs';

    public function __construct(
        private readonly AccessDecision $access,
        private readonly IdempotentExecution $idempotency,
        private readonly AuditRecorder $audit,
        private readonly AttemptedOperation $attemptedOperation,
    ) {}

    /** @return array{schedule_id: string, correlation_id: string} */
    public function register(Actor $actor, string $jobKey, string $name, string $scheduleExpr, string $idempotencyKey): array
    {
        $payload = hash('sha256', implode('|', ['integrations.job.register', $jobKey, $name, $scheduleExpr, $actor->actorId]));

        try {
            return $this->idempotency->execute('integrations.job.register', $idempotencyKey, $payload,
                fn (): array => DB::transaction(function () use ($actor, $jobKey, $name, $scheduleExpr): array {
                    $this->require($actor);
                    JobCatalog::handlerFor($jobKey);
                    if ($name === '' || $scheduleExpr === '') {
                        throw BusinessRejection::forCode('integrations.job_terms', 'a scheduled job carries a name and schedule expression');
                    }
                    if (JobSchedule::query()->where('job_key', $jobKey)->exists()) {
                        throw BusinessRejection::forCode('integrations.job_exists', 'this job key is already scheduled');
                    }

                    $schedule = JobSchedule::query()->create([
                        'id' => RandomIdentifier::new(),
                        'job_key' => $jobKey,
                        'name' => $name,
                        'schedule_expr' => $scheduleExpr,
                        'enabled' => true,
                        'created_by' => $actor->actorId,
                    ]);
                    $event = $this->audit->record($actor->actorId, 'integrations.job.register', 'job_schedule', $schedule->id, null, ['job_key' => $jobKey, 'schedule' => $scheduleExpr]);

                    return ['schedule_id' => $schedule->id, 'correlation_id' => $event->correlation_id];
                }),
            );
        } catch (AuthorizationDenied $denial) {
            $this->attemptedOperation->deniedByActor($denial, $actor, 'integrations.job.register', 'job_schedule', $jobKey);
        }
    }

    /** @return array{schedule_id: string, enabled: bool, correlation_id: string} */
    public function toggle(Actor $actor, JobSchedule $schedule, bool $enabled, string $idempotencyKey): array
    {
        $payload = hash('sha256', implode('|', ['integrations.job.toggle', $schedule->id, $enabled ? '1' : '0', $actor->actorId]));

        try {
            return $this->idempotency->execute('integrations.job.toggle', $idempotencyKey, $payload,
                fn (): array => DB::transaction(function () use ($actor, $schedule, $enabled): array {
                    $this->require($actor);

                    /** @var JobSchedule $locked */
                    $locked = JobSchedule::query()->whereKey($schedule->id)->lockForUpdate()->firstOrFail();
                    $locked->forceFill(['enabled' => $enabled]);
                    $locked->save();
                    $event = $this->audit->record($actor->actorId, 'integrations.job.toggle', 'job_schedule', $locked->id, null, ['enabled' => $enabled]);

                    return ['schedule_id' => $locked->id, 'enabled' => $enabled, 'correlation_id' => $event->correlation_id];
                }),
            );
        } catch (AuthorizationDenied $denial) {
            $this->attemptedOperation->deniedByActor($denial, $actor, 'integrations.job.toggle', 'job_schedule', $schedule->id);
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
