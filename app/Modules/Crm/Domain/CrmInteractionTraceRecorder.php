<?php

declare(strict_types=1);

namespace App\Modules\Crm\Domain;

use App\Modules\Academic\Models\AssessmentAttempt;
use App\Modules\Academic\Placement\Models\PlacementAttempt;
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
 * caller (Finance/Communication/Documents); CRM only appends its timeline
 * evidence inside the same transaction so a payment, message, or document is
 * never recorded without its lead path. It deliberately performs no separate
 * CRM capability decision (the caller already passed its own authority) and
 * does not run automation, because automation is a CRM-staff behavior, not a
 * finance/communication side effect.
 */
final class CrmInteractionTraceRecorder
{
    public function __construct(private readonly AuditRecorder $audit) {}

    public function visitorIdForPerson(string $personId): ?string
    {
        // Prefer the lead that already produced a conversion (it may be
        // closed), otherwise the latest open lead for the person.
        $conversionId = DB::table('visitor_conversions')->where('person_id', $personId)->value('visitor_id');
        if ($conversionId !== null) {
            return (string) $conversionId;
        }
        $id = DB::table('visitors')
            ->where('person_id', $personId)
            ->whereIn('status', Visitor::openStatuses())
            ->value('id');

        return $id !== null ? (string) $id : null;
    }

    public function visitorIdForStudent(string $studentId): ?string
    {
        $conversionId = DB::table('visitor_conversions')->where('student_id', $studentId)->value('visitor_id');
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
    ): string {
        if (in_array($direction, ['inbound', 'outbound'], true) === false) {
            throw BusinessRejection::forCode('crm.interaction_direction', 'interaction direction must be inbound or outbound');
        }
        if (in_array($type, ['call', 'whatsapp', 'email', 'sms', 'visit', 'meeting', 'form_submission', 'document', 'note', 'other', 'payment', 'assessment', 'placement'], true) === false) {
            throw BusinessRejection::forCode('crm.interaction_type', 'unknown interaction type');
        }
        if (in_array($outcome, ['no_answer', 'connected', 'positive', 'neutral', 'negative', 'unreachable', 'requested_info', 'scheduled_visit', 'followup_required', 'not_interested', 'qualified', 'converted', 'other'], true) === false) {
            throw BusinessRejection::forCode('crm.interaction_outcome', 'unknown interaction outcome');
        }
        if (trim($summary) === '') {
            throw BusinessRejection::forCode('crm.interaction_summary', 'an interaction requires a summary');
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
        if (Visitor::query()->whereKey($visitorId)->doesntExist()) {
            throw BusinessRejection::forCode('crm.visitor_unknown', 'the referenced visitor does not exist');
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
            'message_id' => $messageId !== '' ? $messageId : null,
            'document_id' => $documentId !== '' ? $documentId : null,
            'assessment_attempt_id' => $assessmentAttemptId !== '' ? $assessmentAttemptId : null,
            'payment_id' => $paymentId !== '' ? $paymentId : null,
            'placement_attempt_id' => $placementAttemptId !== '' ? $placementAttemptId : null,
            'correlation_id' => RandomIdentifier::new(),
        ]);
        $this->audit->record($actor->actorId, 'crm.interaction.trace', 'visitor_interaction', $interaction->id, null, [
            'visitor_id' => $visitorId, 'type' => $type, 'outcome' => $outcome, 'source' => 'downstream_authority',
        ]);

        return $interaction->id;
    }
}
