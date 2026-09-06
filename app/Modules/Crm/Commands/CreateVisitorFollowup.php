<?php

declare(strict_types=1);

namespace App\Modules\Crm\Commands;

use App\Modules\Audit\AttemptedOperation;
use App\Modules\Audit\AuditRecorder;
use App\Modules\Crm\Domain\CrmAccess;
use App\Modules\Crm\Models\Visitor;
use App\Modules\Crm\Models\VisitorFollowup;
use App\Modules\Identity\Models\Person;
use App\Modules\Identity\Models\UserAccount;
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
                    /** @var Visitor $visitor */
                    $visitor = Visitor::query()->whereKey($visitor->id)->lockForUpdate()->firstOrFail();
                    $this->access->require($actor, self::CAPABILITY, $visitor->origin_branch_id, 'crm.followup_denied');
                    if (! $visitor->isOpen()) {
                        throw BusinessRejection::forCode('crm.followup_closed_visitor', 'a follow-up can only be scheduled on an open visitor');
                    }
                    if (trim($title) === '' || mb_strlen($title) > 160) {
                        throw BusinessRejection::forCode('crm.followup_title', 'a follow-up requires a title of at most 160 characters');
                    }
                    if ($notes !== null && mb_strlen($notes) > 2000) {
                        throw BusinessRejection::forCode('crm.followup_notes', 'follow-up notes cannot exceed 2000 characters');
                    }
                    /** @var Person|null $assignee */
                    $assignee = Person::query()->whereKey($assignedTo)->first();
                    if ($assignee === null) {
                        throw BusinessRejection::forCode('crm.assignee_unknown', 'the assignee does not exist');
                    }
                    if (! $assignee->isVerified()) {
                        throw BusinessRejection::forCode('crm.assignee_unverified', 'a follow-up assignee must be a verified identity');
                    }
                    // Assignment is a capability-bearing operation, not just a
                    // foreign-key check. The target person must be eligible
                    // for the same CRM follow-up scope as the visitor.
                    $this->access->require(new Actor($assignedTo, 'CRM follow-up assignee'), self::CAPABILITY, $visitor->origin_branch_id, 'crm.assignee_not_authorized');

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
                    $after = [
                        'visitor_id' => $visitor->id, 'assigned_to' => $assignedTo,
                        'scheduled_for' => $followup->scheduled_for, 'title' => $followup->title,
                        'created_by' => $followup->created_by,
                    ];
                    $scope = $this->branchScope($visitor->origin_branch_id);
                    if ($scope !== [] && UserAccount::query()->where('person_id', $assignedTo)->where('account_state', UserAccount::STATE_ACTIVE)->exists()) {
                        $after += $scope + [
                            'notification' => [
                                'recipient_actor_id' => $assignedTo,
                                'source_type' => 'visitor_followup',
                                'source_id' => $followup->id,
                                'title' => 'CRM follow-up scheduled: '.$followup->title,
                                'severity' => 'info',
                                'dedupe_key' => 'crm.followup.created.'.$followup->id,
                            ],
                        ];
                    }
                    $event = $this->audit->record($actor->actorId, 'crm.followup.create', 'visitor_followup', $followup->id, null, $after);

                    return ['followup_id' => $followup->id, 'correlation_id' => $event->correlation_id];
                }),
            );
        } catch (AuthorizationDenied $denial) {
            $this->attemptedOperation->deniedByActor($denial, $actor, 'crm.followup.create', 'visitor_followup', $visitor->id);
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
}
