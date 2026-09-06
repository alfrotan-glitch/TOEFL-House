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
use Illuminate\Database\QueryException;
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
                    $personId = trim($personId);

                    if ($personId === '') {
                        throw BusinessRejection::forCode('crm.person_required', 'a person is required to link a visitor');
                    }
                    /** @var Person|null $person */
                    $person = Person::query()->whereKey($personId)->first();
                    if ($person === null) {
                        throw BusinessRejection::forCode('crm.person_unknown', 'the referenced person does not exist');
                    }
                    if (! $person->isVerified()) {
                        throw BusinessRejection::forCode('crm.person_unverified', 'a visitor may only be linked to a verified person');
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
                    $locked->forceFill(['person_id' => $personId, 'updated_by' => $actor->actorId]);
                    $locked->save();
                    $event = $this->audit->record($actor->actorId, 'crm.visitor.link_person', 'visitor', $locked->id, $before, [
                        'person_id' => $personId,
                        'origin_branch_id' => $locked->origin_branch_id,
                        ...$this->branchScope($locked->origin_branch_id),
                    ]);

                    return ['visitor_id' => $locked->id, 'person_id' => $personId, 'correlation_id' => $event->correlation_id];
                }),
            );
        } catch (AuthorizationDenied $denial) {
            $this->attemptedOperation->deniedByActor($denial, $actor, 'crm.visitor.link_person', 'visitor', $visitor->id);
        } catch (QueryException $exception) {
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
