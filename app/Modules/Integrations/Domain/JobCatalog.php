<?php

declare(strict_types=1);

namespace App\Modules\Integrations\Domain;

use App\Modules\Integrations\Jobs\IntegrationRetrySweepJob;
use App\Support\Errors\BusinessRejection;

/**
 * Closed registry of schedulable jobs; a schedule can only reference a
 * catalog job.
 */
final class JobCatalog
{
    /** @var array<string, class-string<JobHandler>> */
    public const HANDLERS = [
        'integrations.retry_sweep' => IntegrationRetrySweepJob::class,
    ];

    /** @return list<string> */
    public static function keys(): array
    {
        return array_keys(self::HANDLERS);
    }

    /** @return class-string<JobHandler> */
    public static function handlerFor(string $jobKey): string
    {
        $handler = self::HANDLERS[$jobKey] ?? null;
        if ($handler === null) {
            throw BusinessRejection::forCode('integrations.job_unknown', sprintf('job %s is not in the job catalog', $jobKey));
        }

        return $handler;
    }
}
