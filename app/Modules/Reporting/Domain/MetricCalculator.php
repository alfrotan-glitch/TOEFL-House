<?php

declare(strict_types=1);

namespace App\Modules\Reporting\Domain;

/**
 * A registered, read-only computation over canonical source facts. The
 * calculator is the only way a metric value can come to exist — there is
 * no manual value entry anywhere.
 */
interface MetricCalculator
{
    /**
     * @return array{value: string, meta: array<string, mixed>}
     */
    public function compute(string $periodId, ?string $scopeId): array;
}
