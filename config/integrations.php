<?php

declare(strict_types=1);

// Integration adapter configuration lives OUTSIDE domain data: transport
// bindings and endpoint secrets are environment configuration, never
// domain columns.
return [
    'transports' => [],
    'secrets' => [],
];
