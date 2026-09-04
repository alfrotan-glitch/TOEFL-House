<?php

declare(strict_types=1);

namespace App\Modules\Crm\Commands;

use App\Modules\Audit\AttemptedOperation;
use App\Modules\Audit\AuditRecorder;
use App\Modules\Crm\Domain\CrmAccess;
use App\Modules\Crm\Models\Visitor;
use App\Modules\Crm\Models\VisitorFollowup;
use App\Support\Authorization\Actor;
use App\Support\Errors\AuthorizationDenied;
use App\Support\Errors\BusinessRejection;
use App\Support\Idempotency\IdempotentExecution;
use App\Support\Identifiers\RandomIdentifier;
use Carbon\CarbonImmutable;
use Illuminate\Support\Facades\DB;

/**
 * Manually schedule a next action on a visitor. This is the same destination
 * as automation — automation is a convenience that never creates a different
 * semantics.
 */
final class CreateVisitorFollowup
{
    public const CAPABILITY = 'crm.followup';

    public function __construct(
        private readonly CrmAccess $access,
        private readonly IdempotentExecution $idempotency,
        private readonly AuditRecorder $audit,
        private readonly AttemptedOperation $attemptedOperation,
    ) {}

    /** @return array{followup_id: string, correlation_id: string} */
    public function create(
        Actor $actor,
        Visitor $visitor,
        string $assignedTo,
        CarbonImmutable $scheduledFor,
        string $title,
        ?string $notes,
        string $idempotencyKey,
    ): array {
        $payload = hash('sha256', implode('|', [
            'crm.followup.create', $visitor->id, $assignedTo, $scheduledFor->toDateString(), trim($title),
            $notes ?? '', $visitor->origin_branch_id ?? '', $actor->actorId,
        ]));

        try {
            return $this->idempotency->execute('crm.followup.create', $idempotencyKey, $payload,
                fn (): array => DB::transaction(function () use ($actor, $visitor, $assignedTo, $scheduledFor, $title, $notes): array {
                    $this->access->require($actor, self::CAPABILITY, $visitor->origin_branch_id, 'crm.followup_denied');
                    if (! $visitor->isOpen()) {
                        throw BusinessRejection::forCode('crm.followup_closed_visitor', 'a follow-up can only be scheduled on an open visitor');
                    }
                    if (trim($title) === '') {
                        throw BusinessRejection::forCode('crm.followup_title', 'a follow-up requires a title');
                    }
                    if (! DB::table('people')->where('id', $assignedTo)->exists()) {
                        throw BusinessRejection::forCode('crm.assignee_unknown', 'the assignee does not exist');
                    }

                    $followup = VisitorFollowup::query()->create([
                        'id' => RandomIdentifier::new(),
                        'visitor_id' => $visitor->id,
                        'assigned_to' => $assignedTo,
                        'scheduled_for' => $scheduledFor->toDateString(),
                        'title' => trim($title),
                        'notes' => $notes !== '' ? $notes : null,
                        'status' => VisitorFollowup::STATUS_OPEN,
                        'created_by' => $actor->actorId,
                        'correlation_id' => RandomIdentifier::new(),
                    ]);
                    $event = $this->audit->record($actor->actorId, 'crm.followup.create', 'visitor_followup', $followup->id, null, [
                        'visitor_id' => $visitor->id, 'assigned_to' => $assignedTo,
                        'scheduled_for' => $followup->scheduled_for, 'title' => $followup->title,
                    ]);

                    return ['followup_id' => $followup->id, 'correlation_id' => $event->correlation_id];
                }),
            );
        } catch (AuthorizationDenied $denial) {
            $this->attemptedOperation->deniedByActor($denial, $actor, 'crm.followup.create', 'visitor_followup', $visitor->id);
        }
    }
}
