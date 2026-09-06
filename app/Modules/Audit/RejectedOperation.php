<?php

declare(strict_types=1);

namespace App\Modules\Audit;

use App\Support\Authorization\Actor;
use App\Support\Errors\DomainError;

/**
 * Material business rejections are evidence too. When an owning transaction
 * rolled back because a domain rule rejected the operation (for example a
 * failing enrollment financial gate), the rejection is committed on its own
 * after the rollback with the same correlation id.
 */
final class RejectedOperation
{
    public function __construct(private readonly AuditRecorder $audit) {}

    /** @param array<string, mixed>|null $afterState */
    public function reject(DomainError $rejection, Actor $actor, string $operation, string $targetType, string $targetId, ?array $afterState): never
    {
        $state = $afterState ?? [];
        $state['error_code'] = $rejection->errorCode();
        $this->audit->record(
            $actor->actorId,
            $operation.'.denied',
            $targetType,
            $targetId,
            null,
            $state,
            $rejection->correlationId(),
        );

        throw $rejection;
    }
}
