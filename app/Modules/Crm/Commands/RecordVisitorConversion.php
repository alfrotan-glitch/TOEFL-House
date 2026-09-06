<?php

declare(strict_types=1);

namespace App\Modules\Crm\Commands;

use App\Modules\Audit\AttemptedOperation;
use App\Modules\Crm\Domain\CrmAccess;
use App\Modules\Crm\Models\Visitor;
use App\Support\Authorization\Actor;
use App\Support\Errors\AuthorizationDenied;
use App\Support\Errors\BusinessRejection;

/**
 * Retained as a fail-closed compatibility boundary for stale callers. CRM
 * never writes downstream conversion facts; Admissions/Students call
 * VisitorConversionRecorder from their own authoritative transactions.
 */
final class RecordVisitorConversion
{
    /** Compatibility rejection boundary; CRM has no downstream conversion capability. */
    public const CAPABILITY = 'crm.visitor';

    public function __construct(
        private readonly CrmAccess $access,
        private readonly AttemptedOperation $attemptedOperation,
    ) {}

    /** CRM intentionally has no downstream conversion return path. */
    public function record(
        Actor $actor,
        Visitor $visitor,
        string $conversionType,
        string $downstreamEntity,
        string $downstreamId,
        string $idempotencyKey,
    ): never {
        try {
            $this->access->require($actor, self::CAPABILITY, $visitor->origin_branch_id, 'crm.conversion_denied');

            throw BusinessRejection::forCode('crm.conversion_authority_required', 'CRM records conversion evidence only; use Admissions or Students to create the downstream conversion');
        } catch (AuthorizationDenied $denial) {
            $this->attemptedOperation->deniedByActor($denial, $actor, 'crm.conversion.record', 'visitor_conversion', $visitor->id);
        }
    }
}
