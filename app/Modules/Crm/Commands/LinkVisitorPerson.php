<?php

declare(strict_types=1);

namespace App\Modules\Crm\Commands;

use App\Modules\Audit\AttemptedOperation;
use App\Modules\Audit\AuditRecorder;
use App\Modules\Crm\Domain\CrmAccess;
use App\Modules\Crm\Models\Visitor;
use App\Modules\Identity\Models\Person;
use App\Support\Authorization\Actor;
use App\Support\Errors\AuthorizationDenied;
use App\Support\Errors\BusinessRejection;
use App\Support\Idempotency\IdempotentExecution;
use Illuminate\Support\Facades\DB;

/**
 * Bind an anonymous visitor to a verified/known Person once evidence
 * supports identity. The identity binding is a lifecycle fact — it is not
 * changed by ordinary updates and never fabricates identity. The schema's
 * one-active-lead-per-person index enforces the invariant at the database.
 */
final class LinkVisitorPerson
{
    public const CAPABILITY = 'crm.visitor';

    public function __construct(
        private readonly CrmAccess $access,
        private readonly IdempotentExecution $idempotency,
        private readonly AuditRecorder $audit,
        private readonly AttemptedOperation $attemptedOperation,
    ) {}

    /** @return array{visitor_id: string, person_id: string, correlation_id: string} */
    public function link(Actor $actor, Visitor $visitor, string $personId, string $idempotencyKey): array
    {
        $payload = hash('sha256', implode('|', ['crm.visitor.link_person', $visitor->id, $personId, $actor->actorId]));

        try {
            return $this->idempotency->execute('crm.visitor.link_person', $idempotencyKey, $payload,
                fn (): array => DB::transaction(function () use ($actor, $visitor, $personId): array {
                    /** @var Visitor $locked */
                    $locked = Visitor::query()->whereKey($visitor->id)->lockForUpdate()->firstOrFail();
                    $this->access->require($actor, self::CAPABILITY, $locked->origin_branch_id, 'crm.visitor_denied');

                    if ($personId === '') {
                        throw BusinessRejection::forCode('crm.person_required', 'a person is required to link a visitor');
                    }
                    if (Person::query()->whereKey($personId)->doesntExist()) {
                        throw BusinessRejection::forCode('crm.person_unknown', 'the referenced person does not exist');
                    }
                    if (trim((string) $locked->person_id) === $personId) {
                        throw BusinessRejection::forCode('crm.visitor_already_linked', 'this visitor is already linked to that person');
                    }
                    if ($locked->person_id !== null && trim((string) $locked->person_id) !== '' && trim((string) $locked->person_id) !== $personId) {
                        throw BusinessRejection::forCode('crm.visitor_person_linked', 'a visitor cannot be re-linked to another person');
                    }
                    if (! $locked->isOpen()) {
                        throw BusinessRejection::forCode('crm.visitor_closed', 'only an open visitor can have an identity linked');
                    }
                    if (Visitor::query()
                        ->where('person_id', $personId)
                        ->where('id', '<>', $locked->id)
                        ->whereIn('status', Visitor::openStatuses())
                        ->exists()) {
                        throw BusinessRejection::forCode('crm.duplicate_person', 'this person already has another open visitor record');
                    }

                    $before = ['person_id' => $locked->person_id];
                    $locked->forceFill(['person_id' => $personId]);
                    $locked->save();
                    $event = $this->audit->record($actor->actorId, 'crm.visitor.link_person', 'visitor', $locked->id, $before, [
                        'person_id' => $personId,
                    ]);

                    return ['visitor_id' => $locked->id, 'person_id' => $personId, 'correlation_id' => $event->correlation_id];
                }),
            );
        } catch (AuthorizationDenied $denial) {
            $this->attemptedOperation->deniedByActor($denial, $actor, 'crm.visitor.link_person', 'visitor', $visitor->id);
        }
    }
}
