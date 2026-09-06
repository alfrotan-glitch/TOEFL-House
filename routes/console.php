<?php

use App\Modules\Integrations\Commands\EnqueueJobRun;
use App\Modules\Integrations\Commands\ProcessJobRun;
use App\Modules\Integrations\Commands\RegisterJob;
use App\Modules\Integrations\Domain\JobCatalog;
use App\Modules\Integrations\Models\JobRun;
use App\Modules\Integrations\Models\JobSchedule;
use App\Support\Authorization\Actor;
use Illuminate\Support\Facades\Artisan;
use Illuminate\Support\Facades\Schedule;

/*
|--------------------------------------------------------------------------
| Console Commands
|--------------------------------------------------------------------------
|
| Durable integration work is entered through an explicit scheduler/operator
| identity. There is no implicit system actor: an unset run-by identity fails
| before a JobRun can be enqueued.
|
*/
Artisan::command('integrations:install-core-schedules {--run-by=}', function (): int {
    $runBy = trim((string) ($this->option('run-by') ?: config('integrations.scheduler_run_by', '')));
    if ($runBy === '') {
        $this->error('INTEGRATIONS_SCHEDULER_RUN_BY or --run-by is required; no fake system actor is permitted.');

        return 1;
    }

    $actor = new Actor($runBy, 'Integration Scheduler');
    foreach (JobCatalog::keys() as $jobKey) {
        if (JobSchedule::query()->where('job_key', $jobKey)->exists()) {
            $this->line($jobKey.': already registered');
            continue;
        }
        $result = app(RegisterJob::class)->register(
            $actor,
            $jobKey,
            $jobKey,
            '* * * * *',
            'console-core-schedule-'.$jobKey,
        );
        $this->line(json_encode($result, JSON_THROW_ON_ERROR));
    }

    return 0;
})->purpose('Register the allowlisted core integration schedules under an explicit durable actor');

Artisan::command('integrations:run {jobKey} {--run-by=}', function (string $jobKey): int {
    $runBy = trim((string) ($this->option('run-by') ?: config('integrations.scheduler_run_by', '')));
    if ($runBy === '') {
        $this->error('INTEGRATIONS_SCHEDULER_RUN_BY or --run-by is required; no fake system actor is permitted.');

        return 1;
    }

    $actor = new Actor($runBy, 'Integration Scheduler');
    $runKey = $jobKey.':'.now()->format('YmdHi');
    $enqueued = app(EnqueueJobRun::class)->enqueue(
        $actor,
        $jobKey,
        $runKey,
        'console-'.$jobKey.'-'.$runKey,
    );
    $run = JobRun::query()->whereKey($enqueued['run_id'])->firstOrFail();
    $result = app(ProcessJobRun::class)->process($actor, $run, 'console-process-'.$run->id);
    $this->line(json_encode($result, JSON_THROW_ON_ERROR));

    return 0;
})->purpose('Enqueue and process one idempotent integration job occurrence under an explicit durable actor');

// These are registration points only. Runtime scheduler/process supervision
// still belongs to deployment operations; an unset identity fails closed.
Schedule::command('integrations:run outbox.relay')->everyMinute()->withoutOverlapping();
Schedule::command('integrations:run integrations.retry_sweep')->everyMinute()->withoutOverlapping();
