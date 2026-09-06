<?php

declare(strict_types=1);

namespace App\Modules\Integrations\Domain;

/**
 * A scheduled job body: consumes committed facts; may issue owner
 * commands only with authorization and idempotent reference; repeated
 * execution must be safe.
 */
interface JobHandler
{
    /** @param  array<string, mixed>  $context
     * @return array<string, mixed> */
    public function handle(array $context): array;
}
