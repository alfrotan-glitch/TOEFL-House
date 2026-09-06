<?php

declare(strict_types=1);

namespace App\Modules\Crm\Commands;

use App\Modules\Audit\AttemptedOperation;
use App\Modules\Crm\Domain\CrmAccess;
use App\Modules\Crm\Domain\VisitorConversionRecorder;
use App\Modules\Crm\Models\Visitor;
use App\Support\Authorization\Actor;
use App\Support\Errors\AuthorizationDenied;

/**
 * CRM-facing manual conversion entry. The CRM capability gate is applied
 * here; the actual lineage write is delegated to the VisitorConversionRecorder
 * that Admissions/Students also invoke from their authoritative commands.
 */
final class RecordVisitorConversion
{
    public const CAPABILITY = 'crm.visitor.convert';

    public function __construct(
        private readonly CrmAccess $access,
        private readonly AttemptedOperation $attemptedOperation,
        private readonly VisitorConversionRecorder $recorder,
    ) {}

    /** @return array{conversion_id: string, visitor_id: string, status: string, correlation_id: string} */
    public function record(
        Actor $actor,
        Visitor $visitor,
        string $conversionType,
        string $downstreamEntity,
        string $downstreamId,
        string $idempotencyKey,
    ): array {
        try {
            $this->access->require($actor, self::CAPABILITY, $visitor->origin_branch_id, 'crm.conversion_denied');

            return $this->recorder->record($actor, $visitor, $conversionType, $downstreamEntity, $downstreamId, $idempotencyKey);
        } catch (AuthorizationDenied $denial) {
            $this->attemptedOperation->deniedByActor($denial, $actor, 'crm.conversion.record', 'visitor_conversion', $visitor->id);
        }
    }
}
