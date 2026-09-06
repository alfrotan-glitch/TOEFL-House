<?php

declare(strict_types=1);

namespace App\Modules\WorkManagement\Domain;

use App\Support\Errors\BusinessRejection;

/** Closed queue registry; arbitrary request-provided queue names are rejected. */
final class WorkQueueCatalog
{
    /** @var array<string, string> */
    private const QUEUES = [
        'admissions.review' => 'Admissions review',
        'admissions.approval' => 'Admissions approval',
        'academic.appeal' => 'Academic appeal review',
        'payroll.exception' => 'Payroll exception',
        'finance.correction' => 'Finance correction approval',
    ];

    public static function assertKnown(string $key): void
    {
        if (! isset(self::QUEUES[$key])) {
            throw BusinessRejection::forCode('workflow.queue_unknown', sprintf('queue %s is not in the governed catalog', $key));
        }
    }

    /** @return list<string> */
    public static function keys(): array
    {
        return array_keys(self::QUEUES);
    }
}
