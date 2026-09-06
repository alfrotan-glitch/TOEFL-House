<?php

declare(strict_types=1);

namespace App\Modules\Crm\Domain;

use App\Modules\Academic\Models\AssessmentAttempt;
use App\Modules\Academic\Placement\Models\PlacementAttempt;
use App\Modules\Audit\Models\AuditEvent;
use App\Modules\Audit\AuditRecorder;
use App\Modules\Communication\Models\Message;
use App\Modules\Crm\Models\Visitor;
use App\Modules\Crm\Models\VisitorInteraction;
use App\Modules\Documents\Models\Document;
use App\Modules\Finance\Models\Payment;
use App\Support\Authorization\Actor;
use App\Support\Errors\BusinessRejection;
use App\Support\Identifiers\RandomIdentifier;
use Carbon\CarbonImmutable;
use Illuminate\Support\Facades\DB;

/**
 * Cross-module CRM timeline recorder. The AUTHORIZING workflow is always the
 * caller (Finance/Communication/Documents/Academic/Placement); CRM only
 * appends its timeline evidence inside the same transaction so a payment,
 * message, document, assessment, or placement fact is never recorded without
 * its lead path. Each trace binds to the caller's immutable authority audit
 * event; CRM does not infer authority from the reference alone. It deliberately
 * performs no separate CRM capability decision (the caller already passed its
 * own authority) and does not run automation, because automation is a
 * CRM-staff behavior, not a downstream side effect.
 */
final class CrmInteractionTraceRecorder
{
    public function __construct(
        private readonly AuditRecorder $audit,
        private readonly CrmInteractionLineage $lineage,
    ) {}

    public function visitorIdForPerson(string $personId): ?string
    {
        // Prefer the lead that already produced a conversion (it may be
        // closed), otherwise the latest open lead for the person.
        $conversionId = DB::table('visitor_conversions')
            ->where('person_id', $personId)
            ->orderByDesc('converted_at')
            ->orderByDesc('id')
            ->value('visitor_id');
        if ($conversionId !== null) {
            return (string) $conversionId;
        }
        $id = DB::table('visitors')
            ->where('person_id', $personId)
            ->whereIn('status', Visitor::openStatuses())
            ->orderByDesc('created_at')
            ->orderByDesc('id')
            ->value('id');

        return $id !== null ? (string) $id : null;
    }

    public function visitorIdForStudent(string $studentId): ?string
    {
        $handoffId = DB::table('visitor_conversion_handoffs')
            ->where('student_id', $studentId)
            ->orderByDesc('converted_at')
            ->orderByDesc('id')
            ->value('visitor_id');
        if ($handoffId !== null) {
            return (string) $handoffId;
        }
        $conversionId = DB::table('visitor_conversions')
            ->where('student_id', $studentId)
            ->orderByDesc('converted_at')
            ->orderByDesc('id')
            ->value('visitor_id');
        if ($conversionId !== null) {
            return (string) $conversionId;
        }
        $personId = DB::table('students')->where('id', $studentId)->value('person_id');
        if ($personId === null) {
            return null;
        }

        return $this->visitorIdForPerson((string) $personId);
    }

    public function record(
        Actor $actor,
        string $visitorId,
        string $direction,
        string $type,
        string $outcome,
        string $summary,
        CarbonImmutable $occurredOn,
        ?string $messageId = null,
        ?string $documentId = null,
        ?string $assessmentAttemptId = null,
        ?string $paymentId = null,
        ?string $placementAttemptId = null,
        ?string $authorityAuditEventId = null,
    ): string {
        if (! VisitorInteractionCatalog::isDirection($direction)) {
            throw BusinessRejection::forCode('crm.interaction_direction', 'interaction direction must be inbound or outbound');
        }
        if (! VisitorInteractionCatalog::isType($type)) {
            throw BusinessRejection::forCode('crm.interaction_type', 'unknown interaction type');
        }
        if (! VisitorInteractionCatalog::isOutcome($outcome)) {
            throw BusinessRejection::forCode('crm.interaction_outcome', 'unknown interaction outcome');
        }
        if (trim($summary) === '' || mb_strlen($summary) > 2000) {
            throw BusinessRejection::forCode('crm.interaction_summary', 'an interaction requires a summary of at most 2000 characters');
        }
        if ($occurredOn->toDateString() > CarbonImmutable::today()->toDateString()) {
            throw BusinessRejection::forCode('crm.interaction_future', 'an interaction cannot be dated in the future');
        }
        if ($messageId !== null && $messageId !== '' && Message::query()->whereKey($messageId)->doesntExist()) {
            throw BusinessRejection::forCode('crm.message_unknown', 'the referenced message does not exist');
        }
        if ($documentId !== null && $documentId !== '' && Document::query()->whereKey($documentId)->doesntExist()) {
            throw BusinessRejection::forCode('crm.document_unknown', 'the referenced document does not exist');
        }
        if ($assessmentAttemptId !== null && $assessmentAttemptId !== '' && AssessmentAttempt::query()->whereKey($assessmentAttemptId)->doesntExist()) {
            throw BusinessRejection::forCode('crm.assessment_unknown', 'the referenced assessment attempt does not exist');
        }
        if ($placementAttemptId !== null && $placementAttemptId !== '' && PlacementAttempt::query()->whereKey($placementAttemptId)->doesntExist()) {
            throw BusinessRejection::forCode('crm.placement_unknown', 'the referenced placement attempt does not exist');
        }
        if ($paymentId !== null && $paymentId !== '' && Payment::query()->whereKey($paymentId)->doesntExist()) {
            throw BusinessRejection::forCode('crm.payment_unknown', 'the referenced payment does not exist');
        }
        $references = array_filter([
            'message' => $messageId,
            'document' => $documentId,
            'assessment' => $assessmentAttemptId,
            'payment' => $paymentId,
            'placement' => $placementAttemptId,
        ], static fn (?string $id): bool => $id !== null && trim($id) !== '');
        if (count($references) === 0) {
            throw BusinessRejection::forCode('crm.interaction_reference_required', 'a downstream CRM trace requires its authoritative record reference');
        }
        if (count($references) > 1) {
            throw BusinessRejection::forCode('crm.interaction_reference_count', 'an interaction may reference only one authoritative record');
        }

        $authorityAuditEventId = trim((string) ($authorityAuditEventId ?? ''));
        if ($authorityAuditEventId === '') {
            throw BusinessRejection::forCode('crm.interaction_authority_event_required', 'a downstream CRM trace requires its authoritative audit event');
        }
        $authorityEvent = AuditEvent::query()->whereKey($authorityAuditEventId)->lockForUpdate()->first();
        $referenceKind = (string) array_key_first($references);
        /** @var array<string, array{operations: list<string>, target_type: string}> $expectedByKind */
        $expectedByKind = [
            'message' => ['operations' => ['communication.message.queue'], 'target_type' => 'message'],
            'document' => ['operations' => ['documents.register'], 'target_type' => 'document'],
            'assessment' => ['operations' => ['academic.attempt.submit'], 'target_type' => 'assessment_attempt'],
            'payment' => ['operations' => ['finance.payment.record'], 'target_type' => 'payment'],
            'placement' => ['operations' => ['placement.attempt.submit', 'placement.attempt.submit.physical.answers'], 'target_type' => 'placement_attempt'],
        ];
        $expected = $expectedByKind[$referenceKind] ?? null;
        if ($expected === null) {
            throw BusinessRejection::forCode('crm.interaction_reference_kind_unknown', 'the interaction reference kind is not governed');
        }
        $expectedOperations = $expected['operations'];
        $expectedTargetType = $expected['target_type'];
        $expectedTargetId = (string) ($references[$referenceKind] ?? '');
        if ($authorityEvent === null
            || $authorityEvent->actor_id !== $actor->actorId
            || $authorityEvent->target_type !== $expectedTargetType
            || $authorityEvent->target_id !== $expectedTargetId
            || ! in_array($authorityEvent->operation, $expectedOperations, true)) {
            throw BusinessRejection::forCode('crm.interaction_authority_event_invalid', 'the authoritative audit event does not match the linked record and actor');
        }
        /** @var Visitor $visitor */
        $visitor = Visitor::query()->whereKey($visitorId)->lockForUpdate()->first();
        if ($visitor === null) {
            throw BusinessRejection::forCode('crm.visitor_unknown', 'the referenced visitor does not exist');
        }
        $authorityState = is_array($authorityEvent->after_state) ? $authorityEvent->after_state : [];
        $authorityBranch = trim((string) ($authorityState['branch_id'] ?? $authorityState['originating_branch_id'] ?? ''));
        $visitorBranch = trim((string) ($visitor->origin_branch_id ?? ''));
        if ($visitorBranch !== '' && $authorityBranch !== '' && $visitorBranch !== $authorityBranch) {
            throw BusinessRejection::forCode('crm.interaction_branch_mismatch', 'the authoritative interaction event does not carry compatible branch provenance');
        }
        $this->lineage->assert($visitor, $type, $messageId, $documentId, $assessmentAttemptId, $paymentId, $placementAttemptId);
        $existingInteraction = VisitorInteraction::query()
            ->where('authority_audit_event_id', $authorityAuditEventId)
            ->first();
        if ($existingInteraction !== null) {
            return (string) $existingInteraction->id;
        }

        $interaction = VisitorInteraction::query()->create([
            'id' => RandomIdentifier::new(),
            'visitor_id' => $visitorId,
            'direction' => $direction,
            'type' => $type,
            'outcome' => $outcome,
            'summary' => trim($summary),
            'occurred_on' => $occurredOn->toDateString(),
            'occurred_at' => $occurredOn->toDateTimeString(),
            'agent_id' => $actor->actorId,
            'trace_origin' => 'downstream',
            'authority_audit_event_id' => $authorityAuditEventId,
            'message_id' => $messageId !== '' ? $messageId : null,
            'document_id' => $documentId !== '' ? $documentId : null,
            'assessment_attempt_id' => $assessmentAttemptId !== '' ? $assessmentAttemptId : null,
            'payment_id' => $paymentId !== '' ? $paymentId : null,
            'placement_attempt_id' => $placementAttemptId !== '' ? $placementAttemptId : null,
            'correlation_id' => RandomIdentifier::new(),
        ]);
        $this->audit->record($actor->actorId, 'crm.interaction.trace', 'visitor_interaction', $interaction->id, null, [
            'visitor_id' => $visitorId, 'type' => $type, 'outcome' => $outcome, 'source' => 'downstream_authority',
            'authority_audit_event_id' => $authorityAuditEventId,
            'message_id' => $messageId, 'document_id' => $documentId,
            'assessment_attempt_id' => $assessmentAttemptId, 'payment_id' => $paymentId,
            'placement_attempt_id' => $placementAttemptId,
            'origin_branch_id' => $visitor->origin_branch_id,
            ...$this->branchScope($visitor->origin_branch_id),
        ]);

        return $interaction->id;
    }

    /** @return array{branch_id: string, organization_id: string}|array{} */
    private function branchScope(?string $branchId): array
    {
        $branchId = trim((string) ($branchId ?? ''));
        if ($branchId === '') {
            return [];
        }
        $scope = DB::table('branches as b')
            ->join('campus_assignments as ca', 'ca.branch_id', '=', 'b.id')
            ->join('campuses as c', 'c.id', '=', 'ca.campus_id')
            ->join('organizations as o', 'o.id', '=', 'c.organization_id')
            ->where('b.id', $branchId)
            ->where('b.lifecycle_state', 'active')
            ->where('c.lifecycle_state', 'active')
            ->where('o.lifecycle_state', 'active')
            ->where('ca.effective_from', '<=', now()->toDateString())
            ->where(fn ($query) => $query->whereNull('ca.effective_to')->orWhere('ca.effective_to', '>', now()->toDateString()))
            ->first(['b.id as branch_id', 'c.organization_id']);

        return $scope === null ? [] : [
            'branch_id' => (string) $scope->branch_id,
            'organization_id' => (string) $scope->organization_id,
        ];
    }
}
