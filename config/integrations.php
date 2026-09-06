<?php

declare(strict_types=1);

// Integration adapter configuration lives OUTSIDE domain data: transport
// bindings and endpoint secrets are environment configuration, never
// domain columns.
return [
    // A durable verified person UUID is required for scheduled integration
    // execution. Empty configuration fails closed; no synthetic actor exists.
    'scheduler_run_by' => env('INTEGRATIONS_SCHEDULER_RUN_BY'),
    'transports' => [],
    'secrets' => [],
];
