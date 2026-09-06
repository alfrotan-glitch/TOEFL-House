<?php

declare(strict_types=1);

namespace App\Modules\Crm\Commands;

use App\Modules\Academic\Models\AssessmentAttempt;
use App\Modules\Audit\AttemptedOperation;
use App\Modules\Audit\AuditRecorder;
use App\Modules\Communication\Models\Message;
use App\Modules\Crm\Domain\CrmAccess;
use App\Modules\Crm\Domain\CrmInteractionLineage;
use App\Modules\Crm\Domain\VisitorInteractionCatalog;
use App\Modules\Crm\Models\Visitor;
use App\Modules\Crm\Models\VisitorAutomationRule;
use App\Modules\Crm\Models\VisitorInteraction;
use App\Modules\Documents\Models\Document;
use App\Modules\Finance\Models\Payment;
use App\Support\Authorization\Actor;
use App\Support\Errors\AuthorizationDenied;
use App\Support\Errors\BusinessRejection;
use App\Support\Idempotency\IdempotentExecution;
use App\Support\Identifiers\RandomIdentifier;
use Carbon\CarbonImmutable;
use Illuminate\Support\Facades\DB;

/**
 * Append an immutable contact/engagement fact and run in-transaction
 * automation. A correction is a new interaction; a matched automation rule
 * schedules a follow-up for the same actor configuration (not a silent
 * workflow).
 */
final class CaptureVisitorInteraction
{
    public const CAPABILITY = 'crm.visitor';

    public function __construct(
        private readonly CrmAccess $access,
        private readonly IdempotentExecution $idempotency,
        private readonly AuditRecorder $audit,
        private readonly AttemptedOperation $attemptedOperation,
        private readonly CrmInteractionLineage $lineage,
        private readonly CreateVisitorFollowup $followups,
    ) {}

    /** @return array{interaction_id: string, scheduled_followup_id: ?string, correlation_id: string} */
    public function capture(
        Actor $actor,
        Visitor $visitor,
        string $direction,
        string $type,
        string $outcome,
        string $summary,
        CarbonImmutable $occurredOn,
        ?string $messageId,
        ?string $documentId,
        ?string $assessmentAttemptId,
        ?string $paymentId,
        string $idempotencyKey,
        ?string $placementAttemptId = null,
    ): array {
        $payload = hash('sha256', implode('|', [
            'crm.interaction.capture', $visitor->id, $direction, $type, $outcome, $summary,
            $occurredOn->toDateString(), $messageId ?? '', $documentId ?? '', $assessmentAttemptId ?? '', $paymentId ?? '', $placementAttemptId ?? '', $actor->actorId,
        ]));

        try {
            return $this->idempotency->execute('crm.interaction.capture', $idempotencyKey, $payload,
                fn (): array => DB::transaction(function () use ($actor, $visitor, $direction, $type, $outcome, $summary, $occurredOn, $messageId, $documentId, $assessmentAttemptId, $paymentId, $placementAttemptId): array {
                    /** @var Visitor $visitor */
                    $visitor = Visitor::query()->whereKey($visitor->id)->lockForUpdate()->firstOrFail();
                    $this->access->require($actor, self::CAPABILITY, $visitor->origin_branch_id, 'crm.interaction_denied');
                    if (! $visitor->isOpen()) {
                        throw BusinessRejection::forCode('crm.interaction_closed_visitor', 'manual interactions can only be recorded for an open visitor');
                    }
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
                    if ($assessmentAttemptId !== null && $assessmentAttemptId !== ''
                        && AssessmentAttempt::query()->whereKey($assessmentAttemptId)->doesntExist()) {
                        throw BusinessRejection::forCode('crm.assessment_unknown', 'the referenced placement/assessment attempt does not exist');
                    }
                    if ($paymentId !== null && $paymentId !== '' && Payment::query()->whereKey($paymentId)->doesntExist()) {
                        throw BusinessRejection::forCode('crm.payment_unknown', 'the referenced payment does not exist');
                    }
                    if ($placementAttemptId !== null && $placementAttemptId !== ''
                        && DB::table('placement_attempts')->where('id', $placementAttemptId)->doesntExist()) {
                        throw BusinessRejection::forCode('crm.placement_unknown', 'the referenced placement attempt does not exist');
                    }
                    $this->lineage->assert($visitor, $type, $messageId, $documentId, $assessmentAttemptId, $paymentId, $placementAttemptId);

                    $interaction = VisitorInteraction::query()->create([
                        'id' => RandomIdentifier::new(),
                        'visitor_id' => $visitor->id,
                        'direction' => $direction,
                        'type' => $type,
                        'outcome' => $outcome,
                        'summary' => trim($summary),
                        'occurred_on' => $occurredOn->toDateString(),
                        'occurred_at' => $occurredOn->toDateTimeString(),
                        'agent_id' => $actor->actorId,
                        'trace_origin' => 'crm',
                        'authority_audit_event_id' => null,
                        'message_id' => $messageId !== '' ? $messageId : null,
                        'document_id' => $documentId !== '' ? $documentId : null,
                        'assessment_attempt_id' => $assessmentAttemptId !== '' ? $assessmentAttemptId : null,
                        'payment_id' => $paymentId !== '' ? $paymentId : null,
                        'placement_attempt_id' => $placementAttemptId !== '' ? $placementAttemptId : null,
                        'correlation_id' => RandomIdentifier::new(),
                    ]);

                    $followupId = $this->runAutomation($actor, $visitor, $outcome, $interaction->correlation_id);
                    $event = $this->audit->record($actor->actorId, 'crm.interaction.capture', 'visitor_interaction', $interaction->id, null, [
                        'visitor_id' => $visitor->id, 'direction' => $direction, 'type' => $type, 'outcome' => $outcome,
                        'correlation_id' => $interaction->correlation_id,
                        'origin_branch_id' => $visitor->origin_branch_id,
                        ...$this->branchScope($visitor->origin_branch_id),
                    ]);

                    return ['interaction_id' => $interaction->id, 'scheduled_followup_id' => $followupId, 'correlation_id' => $event->correlation_id];
                }),
            );
        } catch (AuthorizationDenied $denial) {
            $this->attemptedOperation->deniedByActor($denial, $actor, 'crm.interaction.capture', 'visitor_interaction', $visitor->id);
        }
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

    private function runAutomation(Actor $actor, Visitor $visitor, string $outcome, string $correlationId): ?string
    {
        /** @var VisitorAutomationRule|null $rule */
        $rule = VisitorAutomationRule::query()
            ->where('is_active', true)
            ->where('trigger_type', 'interaction_outcome')
            ->where('trigger_value', $outcome)
            ->where('action_type', 'schedule_followup')
            ->lockForUpdate()
            ->first();

        if ($rule === null) {
            return null;
        }

        $days = (int) ($rule->action_config['due_in_days'] ?? 1);
        $assignee = $rule->action_config['assignee'] ?? $actor->actorId;
        $title = $rule->action_config['title'] ?? 'Follow up on '.$outcome;
        if ($days < 0 || $days > 365 || ! is_string($assignee) || trim($assignee) === '' || ! is_string($title) || trim($title) === '' || mb_strlen($title) > 160) {
            throw BusinessRejection::forCode('crm.automation_config', 'automation rule action_config must include assignee and title');
        }

        $followup = $this->followups->create(
            $actor,
            $visitor,
            $assignee,
            CarbonImmutable::now()->addDays($days),
            $title,
            'Created automatically from interaction outcome '.$outcome.'.',
            'crm-automation-followup-'.$correlationId,
        );

        return $followup['followup_id'];
    }
}
