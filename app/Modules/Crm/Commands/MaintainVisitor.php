<?php

declare(strict_types=1);

namespace App\Modules\Crm\Commands;

use App\Modules\Audit\AttemptedOperation;
use App\Modules\Audit\AuditRecorder;
use App\Modules\Crm\Domain\CrmAccess;
use App\Modules\Crm\Domain\VisitorContactKey;
use App\Modules\Crm\Domain\VisitorStatus;
use App\Modules\Crm\Models\Visitor;
use App\Support\Authorization\Actor;
use App\Support\Errors\AuthorizationDenied;
use App\Support\Errors\BusinessRejection;
use App\Support\Idempotency\IdempotentExecution;
use Illuminate\Support\Facades\DB;

/**
 * Maintain a visitor: update contact/ownership/interest/notes and advance the
 * pipeline stage. Provenance (origin_branch_id) and identity binding are never
 * changed here — those are immutable facts fixed at capture (or removed via a
 * separate, audited merge decision, outside this module).
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
                    VisitorStatus::requireTransition($locked->status, $toStatus);
                    if ($toStatus === Visitor::STATUS_LOST && ($reason === null || trim($reason) === '')) {
                        throw BusinessRejection::forCode('crm.visitor_loss_reason', 'a loss requires a documented reason');
                    }

                    $before = ['status' => $locked->status];
                    $locked->forceFill(['status' => $toStatus]);
                    $locked->save();
                    $event = $this->audit->record($actor->actorId, 'crm.visitor.transition', 'visitor', $locked->id, $before, [
                        'status' => $toStatus, 'reason' => $reason,
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

                    if ($fullName !== null && trim($fullName) === '') {
                        throw BusinessRejection::forCode('crm.visitor_name_required', 'a visitor record requires a name');
                    }
                    if ($preferredChannel !== null && in_array($preferredChannel, ['phone', 'whatsapp', 'email', 'sms', 'in_person', 'other'], true) === false) {
                        throw BusinessRejection::forCode('crm.visitor_channel_unknown', 'unknown preferred contact channel');
                    }
                    if ($rating !== null && in_array($rating, ['hot', 'warm', 'cold'], true) === false) {
                        throw BusinessRejection::forCode('crm.visitor_rating_unknown', 'unknown visitor rating');
                    }
                    if ($assignedTo !== null && $assignedTo !== '' && ! $this->personExists($assignedTo)) {
                        throw BusinessRejection::forCode('crm.assignee_unknown', 'the assignee does not exist');
                    }

                    $contactKey = ($email !== null || $phone !== null)
                        ? VisitorContactKey::of($email ?? $locked->email, $phone ?? $locked->phone)
                        : $locked->contact_key;
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
                        'phone' => $phone !== null && $phone !== '' ? $phone : $locked->phone,
                        'email' => $email !== null && $email !== '' ? $email : $locked->email,
                        'preferred_channel' => $preferredChannel ?? $locked->preferred_channel,
                        'rating' => $rating ?? $locked->rating,
                        'interest' => $interest ?? $locked->interest,
                        'notes' => $notes ?? $locked->notes,
                        'assigned_to' => $assignedTo ?? $locked->assigned_to,
                        'updated_by' => $actor->actorId,
                    ]);
                    $locked->save();
                    $event = $this->audit->record($actor->actorId, 'crm.visitor.update', 'visitor', $locked->id, $before, [
                        'full_name' => $locked->full_name, 'phone' => $locked->phone, 'email' => $locked->email,
                        'preferred_channel' => $locked->preferred_channel, 'rating' => $locked->rating,
                        'interest' => $locked->interest, 'assigned_to' => $locked->assigned_to,
                    ]);

                    return ['visitor_id' => $locked->id, 'correlation_id' => $event->correlation_id];
                }),
            );
        } catch (AuthorizationDenied $denial) {
            $this->attemptedOperation->deniedByActor($denial, $actor, 'crm.visitor.update', 'visitor', $visitor->id);
        }
    }

    private function personExists(string $personId): bool
    {
        return DB::table('people')->where('id', $personId)->exists();
    }
}
