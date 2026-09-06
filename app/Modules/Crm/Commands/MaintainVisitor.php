<?php

declare(strict_types=1);

namespace App\Modules\Crm\Commands;

use App\Modules\Audit\AttemptedOperation;
use App\Modules\Audit\AuditRecorder;
use App\Modules\Crm\Domain\CrmAccess;
use App\Modules\Crm\Domain\VisitorContactKey;
use App\Modules\Crm\Domain\VisitorStatus;
use App\Modules\Crm\Models\Visitor;
use App\Modules\Identity\Models\Person;
use App\Support\Authorization\Actor;
use App\Support\Errors\AuthorizationDenied;
use App\Support\Errors\BusinessRejection;
use App\Support\Idempotency\IdempotentExecution;
use Illuminate\Database\QueryException;
use Illuminate\Support\Facades\DB;

/**
 * Maintain a visitor: update contact/ownership/interest/notes and advance the
 * pipeline stage. Provenance (origin_branch_id) and identity binding are never
 * changed here — those are immutable facts fixed at capture. CRM has no
 * in-place merge operation: duplicate records are rejected and remain
 * historical evidence until an explicit data-governance authority defines an
 * audited merge policy.
 */
final class MaintainVisitor
{
    public const CAPABILITY = 'crm.visitor';

    public function __construct(
        private readonly CrmAccess $access,
        private readonly IdempotentExecution $idempotency,
        private readonly AuditRecorder $audit,
        private readonly AttemptedOperation $attemptedOperation,
    ) {}

    /** @return array{visitor_id: string, status: string, correlation_id: string} */
    public function transition(
        Actor $actor,
        Visitor $visitor,
        string $toStatus,
        ?string $reason,
        string $idempotencyKey,
    ): array {
        $payload = hash('sha256', implode('|', ['crm.visitor.transition', $visitor->id, $toStatus, $reason ?? '', $actor->actorId]));

        try {
            return $this->idempotency->execute('crm.visitor.transition', $idempotencyKey, $payload,
                fn (): array => DB::transaction(function () use ($actor, $visitor, $toStatus, $reason): array {
                    /** @var Visitor $locked */
                    $locked = Visitor::query()->whereKey($visitor->id)->lockForUpdate()->firstOrFail();
                    $this->access->require($actor, self::CAPABILITY, $locked->origin_branch_id, 'crm.visitor_denied');
                    if ($toStatus === Visitor::STATUS_CONVERTED) {
                        throw BusinessRejection::forCode('crm.conversion_authority_required', 'only the authoritative Admissions or Students workflow may convert a visitor');
                    }
                    VisitorStatus::requireTransition($locked->status, $toStatus);
                    if ($toStatus === Visitor::STATUS_LOST && ($reason === null || trim($reason) === '')) {
                        throw BusinessRejection::forCode('crm.visitor_loss_reason', 'a loss requires a documented reason');
                    }

                    $before = ['status' => $locked->status];
                    $locked->forceFill(['status' => $toStatus, 'updated_by' => $actor->actorId]);
                    $locked->save();
                    $event = $this->audit->record($actor->actorId, 'crm.visitor.transition', 'visitor', $locked->id, $before, [
                        'status' => $toStatus, 'reason' => $reason,
                        'origin_branch_id' => $locked->origin_branch_id,
                        ...$this->branchScope($locked->origin_branch_id),
                    ]);

                    return ['visitor_id' => $locked->id, 'status' => $toStatus, 'correlation_id' => $event->correlation_id];
                }),
            );
        } catch (AuthorizationDenied $denial) {
            $this->attemptedOperation->deniedByActor($denial, $actor, 'crm.visitor.transition', 'visitor', $visitor->id);
        }
    }

    /** @return array{visitor_id: string, correlation_id: string} */
    public function update(
        Actor $actor,
        Visitor $visitor,
        ?string $fullName,
        ?string $phone,
        ?string $email,
        ?string $preferredChannel,
        ?string $rating,
        ?string $interest,
        ?string $notes,
        ?string $assignedTo,
        string $idempotencyKey,
    ): array {
        $payload = hash('sha256', implode('|', [
            'crm.visitor.update', $visitor->id, $fullName ?? '', $phone ?? '', strtolower(trim($email ?? '')),
            $preferredChannel ?? '', $rating ?? '', $interest ?? '', $notes ?? '', $assignedTo ?? '', $actor->actorId,
        ]));

        try {
            return $this->idempotency->execute('crm.visitor.update', $idempotencyKey, $payload,
                fn (): array => DB::transaction(function () use ($actor, $visitor, $fullName, $phone, $email, $preferredChannel, $rating, $interest, $notes, $assignedTo): array {
                    /** @var Visitor $locked */
                    $locked = Visitor::query()->whereKey($visitor->id)->lockForUpdate()->firstOrFail();
                    $this->access->require($actor, self::CAPABILITY, $locked->origin_branch_id, 'crm.visitor_denied');
                    if (! $locked->isOpen()) {
                        throw BusinessRejection::forCode('crm.visitor_closed', 'only open pipeline visitors may be edited; terminal history is immutable');
                    }

                    if ($fullName !== null && trim($fullName) === '') {
                        throw BusinessRejection::forCode('crm.visitor_name_required', 'a visitor record requires a name');
                    }
                    if (($fullName !== null && mb_strlen($fullName) > 255)
                        || ($phone !== null && mb_strlen($phone) > 255)
                        || ($email !== null && mb_strlen($email) > 255)
                        || ($interest !== null && mb_strlen($interest) > 255)
                        || ($notes !== null && mb_strlen($notes) > 2000)) {
                        throw BusinessRejection::forCode('crm.visitor_field_length', 'visitor fields exceed their permitted lengths');
                    }
                    if ($preferredChannel !== null && in_array($preferredChannel, ['phone', 'whatsapp', 'email', 'sms', 'in_person', 'other'], true) === false) {
                        throw BusinessRejection::forCode('crm.visitor_channel_unknown', 'unknown preferred contact channel');
                    }
                    if ($rating !== null && in_array($rating, ['hot', 'warm', 'cold'], true) === false) {
                        throw BusinessRejection::forCode('crm.visitor_rating_unknown', 'unknown visitor rating');
                    }
                    if ($assignedTo !== null) {
                        $assignedTo = trim($assignedTo);
                        if ($assignedTo !== '') {
                            /** @var Person|null $assignee */
                            $assignee = Person::query()->whereKey($assignedTo)->first();
                            if ($assignee === null) {
                                throw BusinessRejection::forCode('crm.assignee_unknown', 'the assignee does not exist');
                            }
                            if (! $assignee->isVerified()) {
                                throw BusinessRejection::forCode('crm.assignee_unverified', 'a visitor assignee must be a verified identity');
                            }
                            $this->access->require(new Actor($assignedTo, 'CRM visitor assignee'), self::CAPABILITY, $locked->origin_branch_id, 'crm.assignee_not_authorized');
                        }
                    }

                    $contactKey = ($email !== null || $phone !== null)
                        ? VisitorContactKey::of($email ?? $locked->email, $phone ?? $locked->phone)
                        : $locked->contact_key;
                    if ($contactKey === '' && $locked->person_id === null) {
                        throw BusinessRejection::forCode('crm.visitor_contact_required', 'an anonymous visitor needs at least a phone or email');
                    }
                    if ($contactKey !== '' && $contactKey !== $locked->contact_key
                        && Visitor::query()
                            ->where('contact_key', $contactKey)
                            ->where('id', '<>', $locked->id)
                            ->whereIn('status', Visitor::openStatuses())
                            ->exists()) {
                        throw BusinessRejection::forCode('crm.duplicate_contact', 'an open visitor already exists for this primary contact');
                    }

                    $before = [
                        'full_name' => $locked->full_name, 'phone' => $locked->phone, 'email' => $locked->email,
                        'preferred_channel' => $locked->preferred_channel, 'rating' => $locked->rating,
                        'interest' => $locked->interest, 'notes' => $locked->notes, 'assigned_to' => $locked->assigned_to,
                    ];
                    $locked->forceFill([
                        'full_name' => $fullName !== null ? trim($fullName) : $locked->full_name,
                        'phone' => $phone !== null ? ($phone !== '' ? $phone : null) : $locked->phone,
                        'email' => $email !== null ? ($email !== '' ? $email : null) : $locked->email,
                        'preferred_channel' => $preferredChannel ?? $locked->preferred_channel,
                        'rating' => $rating ?? $locked->rating,
                        'interest' => $interest ?? $locked->interest,
                        'notes' => $notes ?? $locked->notes,
                        'contact_key' => $contactKey,
                        'assigned_to' => $assignedTo !== null
                            ? ($assignedTo !== '' ? $assignedTo : null)
                            : $locked->assigned_to,
                        'updated_by' => $actor->actorId,
                    ]);
                    $locked->save();
                    $event = $this->audit->record($actor->actorId, 'crm.visitor.update', 'visitor', $locked->id, $before, [
                        'full_name' => $locked->full_name, 'phone' => $locked->phone, 'email' => $locked->email,
                        'preferred_channel' => $locked->preferred_channel, 'rating' => $locked->rating,
                        'interest' => $locked->interest, 'contact_key' => $locked->contact_key, 'assigned_to' => $locked->assigned_to,
                        'origin_branch_id' => $locked->origin_branch_id,
                        ...$this->branchScope($locked->origin_branch_id),
                    ]);

                    return ['visitor_id' => $locked->id, 'correlation_id' => $event->correlation_id];
                }),
            );
        } catch (AuthorizationDenied $denial) {
            $this->attemptedOperation->deniedByActor($denial, $actor, 'crm.visitor.update', 'visitor', $visitor->id);
        } catch (QueryException $exception) {
            if (str_contains($exception->getMessage(), 'visitors_one_active_per_contact')) {
                throw BusinessRejection::forCode('crm.duplicate_contact', 'an open visitor already exists for this primary contact');
            }
            if (str_contains($exception->getMessage(), 'visitors_one_active_per_person')) {
                throw BusinessRejection::forCode('crm.duplicate_person', 'this person already has another open visitor record');
            }
            throw $exception;
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
