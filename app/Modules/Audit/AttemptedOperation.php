<?php

declare(strict_types=1);

namespace App\Modules\Audit;

use App\Support\Authorization\Actor;
use App\Support\Errors\AuthorizationDenied;

/**
 * Material denials are evidence too: when an owning transaction rolled back
 * because server authorization denied the operation, the denial is committed
 * on its own after the rollback.
 */
final class AttemptedOperation
{
    public function __construct(private readonly AuditRecorder $audit) {}

    public function deniedByActor(AuthorizationDenied $denial, Actor $actor, string $operation, string $targetType, string $targetId): never
    {
        $this->audit->record(
            $actor->actorId,
            $operation.'.denied',
            $targetType,
            $targetId,
            null,
            ['capability_reason' => $denial->getMessage(), 'error_code' => $denial->errorCode()],
            $denial->correlationId(),
        );

        throw $denial;
    }
}
