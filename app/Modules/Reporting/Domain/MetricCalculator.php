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
     * `completeness` is optional because most authoritative calculations are
     * fully known. A calculator must return `incomplete` rather than turn
     * unresolved historical provenance or temporal evidence into a deceptively
     * complete slice.
     *
     * @return array{value: string, meta: array<string, mixed>, completeness?: 'complete'|'incomplete'}
     */
    public function compute(string $periodId, ?string $scopeId): array;
}
