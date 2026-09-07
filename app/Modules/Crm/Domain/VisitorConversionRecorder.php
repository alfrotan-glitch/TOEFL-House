<?php

declare(strict_types=1);

namespace App\Modules\Crm\Domain;

use App\Modules\Admissions\Domain\ApplicantLifecycle;
use App\Modules\Admissions\Models\Applicant;
use App\Modules\Audit\AuditRecorder;
use App\Modules\Audit\Models\AuditEvent;
use App\Modules\Crm\Models\Visitor;
use App\Modules\Crm\Models\VisitorConversion;
use App\Modules\Crm\Models\VisitorFollowup;
use App\Modules\Crm\Models\VisitorConversionHandoff;
use App\Modules\Organization\Models\Branch;
use App\Modules\Identity\Models\Person;
use App\Modules\Students\Domain\StudentStatusRegistry;
use App\Modules\Students\Models\Student;
use App\Modules\Students\Models\StudentStatus;
use App\Modules\Identity\Models\UserAccount;
use App\Support\Authorization\Actor;
use App\Support\Errors\BusinessRejection;
use App\Support\Idempotency\IdempotentExecution;
use App\Support\Identifiers\RandomIdentifier;
use Illuminate\Database\QueryException;
use Illuminate\Support\Facades\DB;

/**
 * Cross-module conversion lineage recorder. The AUTHORIZING workflow is
 * always the caller — Admissions/Students owns the conversion, and this
 * recorder only persists the CRM conversion trace, any later Student handoff,
 * status, and audit inside the same transaction. It deliberately performs no
 * separate capability decision so that an Admissions/Students conversion can
 * never be split into a "successful downstream record, unlinked visitor"
 * outcome. The explicit authority parameter and immutable downstream
 * audit-event binding reject direct CRM writes and unproven conversion claims.
 */
final class VisitorConversionRecorder
{
    public function __construct(
        private readonly AuditRecorder $audit,
        private readonly IdempotentExecution $idempotency,
    ) {}

    /** @return array{conversion_id: string, visitor_id: string, status: string, converted_at: string|null, conversion_time_basis: string|null, correlation_id: string} */
    public function record(
        Actor $actor,
        Visitor $visitor,
        string $conversionType,
        string $downstreamEntity,
        string $downstreamId,
        string $idempotencyKey,
        string $authority = 'crm',
        ?string $authorityAuditEventId = null,
    ): array {
        $payload = hash('sha256', implode('|', [
            'crm.conversion.record', $visitor->id, $conversionType, $downstreamEntity, $downstreamId, $authority, $authorityAuditEventId ?? '', $actor->actorId,
        ]));

        try {
            return $this->idempotency->execute('crm.conversion.record', $idempotencyKey, $payload,
                fn (): array => DB::transaction(function () use ($actor, $visitor, $conversionType, $downstreamEntity, $downstreamId, $authority, $authorityAuditEventId): array {
                // Deduplicate: if the exact conversion already exists, the
                // idempotency map normally catches a repeat; the unique
                // visitor conversion is the hard truth either way.
                /** @var Visitor $locked */
                $locked = Visitor::query()->whereKey($visitor->id)->lockForUpdate()->firstOrFail();

                if (in_array($conversionType, ['applicant', 'student'], true) === false) {
                    throw BusinessRejection::forCode('crm.conversion_type', 'only authoritative applicant or student conversions are supported');
                }
                if (($conversionType === 'applicant' && $authority !== 'admissions')
                    || ($conversionType === 'student' && $authority !== 'students')) {
                    throw BusinessRejection::forCode('crm.conversion_authority_required', 'Admissions or Students must own the downstream conversion');
                }
                $authorityAuditEventId = trim((string) ($authorityAuditEventId ?? ''));
                $authorityEvent = $authorityAuditEventId === '' ? null : AuditEvent::query()->whereKey($authorityAuditEventId)->first();
                $expectedOperations = $conversionType === 'applicant' ? ['admissions.register'] : ['admissions.convert', 'students.register'];
                $expectedTargetType = $conversionType === 'applicant' ? 'applicant' : 'student';
                if ($authorityEvent === null
                    || $authorityEvent->actor_id !== $actor->actorId
                    || $authorityEvent->target_type !== $expectedTargetType
                    || $authorityEvent->target_id !== $downstreamId
                    || ! in_array($authorityEvent->operation, $expectedOperations, true)) {
                    throw BusinessRejection::forCode('crm.conversion_authority_event_invalid', 'the conversion must bind to the authoritative downstream audit event');
                }
                $existingConversion = VisitorConversion::query()->where('visitor_id', $locked->id)->first();
                if ($existingConversion !== null) {
                    if ($conversionType === 'student' && $existingConversion->conversion_type === 'applicant') {
                        return $this->recordStudentHandoff($actor, $locked, $existingConversion, $downstreamEntity, $downstreamId, $authorityAuditEventId);
                    }
                    throw BusinessRejection::forCode('crm.conversion_exists', 'this visitor already has a conversion record');
                }
                if (! $locked->isOpen()) {
                    throw BusinessRejection::forCode('crm.conversion_visitor_closed', 'only an open visitor can be converted');
                }

                [$personId, $applicantId, $studentId] = $this->resolveDownstream($conversionType, $downstreamEntity, $downstreamId, $locked);
                $this->bindPerson($locked, $personId, $actor->actorId);
                $this->closeOpenFollowups($locked, $actor);

                $conversion = VisitorConversion::query()->create([
                    'id' => RandomIdentifier::new(),
                    'visitor_id' => $locked->id,
                    'conversion_type' => $conversionType,
                    'authority' => $authority,
                    'person_id' => $personId,
                    'applicant_id' => $applicantId,
                    'student_id' => $studentId,
                    'converted_by' => $actor->actorId,
                    'authority_audit_event_id' => $authorityAuditEventId,
                    'correlation_id' => RandomIdentifier::new(),
                ]);

                // The database copies the bound downstream authority audit
                // event's clock; reload before audit/transport output instead
                // of treating CRM mirror insertion time as conversion evidence.
                /** @var VisitorConversion $conversion */
                $conversion = VisitorConversion::query()->whereKey($conversion->id)->firstOrFail();

                $before = ['status' => $locked->status];
                VisitorStatus::requireTransition($locked->status, Visitor::STATUS_CONVERTED);
                $locked->forceFill(['status' => Visitor::STATUS_CONVERTED, 'updated_by' => $actor->actorId]);
                $locked->save();

                $event = $this->audit->record($actor->actorId, 'crm.conversion.record', 'visitor_conversion', $conversion->id, null, [
                    'visitor_id' => $locked->id, 'conversion_type' => $conversionType,
                    'person_id' => $personId, 'applicant_id' => $applicantId, 'student_id' => $studentId,
                    'prev_status' => $before['status'], 'status' => Visitor::STATUS_CONVERTED,
                    'downstream_entity' => $downstreamEntity, 'downstream_id' => $downstreamId, 'authority' => $authority,
                    'authority_audit_event_id' => $authorityAuditEventId,
                    'converted_at' => $conversion->converted_at?->toDateTimeString(),
                    'conversion_time_basis' => $conversion->conversion_time_basis,
                    ...$this->branchProvenance($conversionType, $downstreamId),
                ]);

                return [
                    'conversion_id' => $conversion->id,
                    'visitor_id' => $locked->id,
                    'status' => Visitor::STATUS_CONVERTED,
                    'converted_at' => $conversion->converted_at?->toDateTimeString(),
                    'conversion_time_basis' => $conversion->conversion_time_basis,
                    'correlation_id' => $event->correlation_id,
                ];
                }),
            );
        } catch (QueryException $exception) {
            if (str_contains($exception->getMessage(), 'visitors_one_active_per_person')) {
                throw BusinessRejection::forCode('crm.duplicate_person', 'the downstream identity already has another open visitor record');
            }
            if (str_contains($exception->getMessage(), 'visitor_conversions_visitor_id_unique')) {
                throw BusinessRejection::forCode('crm.conversion_exists', 'this visitor already has a conversion record');
            }
            if (str_contains($exception->getMessage(), 'visitor_conversions_applicant_unique')
                || str_contains($exception->getMessage(), 'visitor_conversions_student_unique')) {
                throw BusinessRejection::forCode('crm.downstream_already_traced', 'the downstream record already has a CRM conversion trace');
            }
            if (str_contains($exception->getMessage(), 'visitor_conversions_authority_event_unique')) {
                throw BusinessRejection::forCode('crm.conversion_authority_event_reused', 'the authoritative downstream event already has a CRM conversion trace');
            }
            if (str_contains($exception->getMessage(), 'visitor_conversion_handoffs_source_unique')) {
                throw BusinessRejection::forCode('crm.conversion_handoff_exists', 'this applicant conversion already has a Student handoff trace');
            }
            if (str_contains($exception->getMessage(), 'visitor_conversion_handoffs_student_unique')) {
                throw BusinessRejection::forCode('crm.downstream_already_traced', 'the downstream Student already has a CRM handoff trace');
            }
            if (str_contains($exception->getMessage(), 'visitor_conversion_handoffs_authority_event_unique')) {
                throw BusinessRejection::forCode('crm.conversion_authority_event_reused', 'the authoritative Student event already has a CRM handoff trace');
            }
            throw $exception;
        }
    }

    /** @return array{conversion_id: string, visitor_id: string, status: string, converted_at: string|null, conversion_time_basis: string|null, correlation_id: string} */
    private function recordStudentHandoff(
        Actor $actor,
        Visitor $visitor,
        VisitorConversion $sourceConversion,
        string $downstreamEntity,
        string $downstreamId,
        string $authorityAuditEventId,
    ): array {
        [$personId, , $studentId] = $this->resolveDownstream('student', $downstreamEntity, $downstreamId, $visitor);
        if ($sourceConversion->person_id !== $personId) {
            throw BusinessRejection::forCode('crm.conversion_person_mismatch', 'the Student handoff does not belong to the original applicant conversion person');
        }
        $studentApplicantId = DB::table('students as s')
            ->join('admission_decisions as d', 'd.id', '=', 's.admission_decision_id')
            ->where('s.id', $studentId)
            ->value('d.applicant_id');
        if ((string) $studentApplicantId !== (string) $sourceConversion->applicant_id) {
            throw BusinessRejection::forCode('crm.conversion_handoff_mismatch', 'the Student handoff must belong to the Applicant represented by the original CRM conversion');
        }
        $handoff = VisitorConversionHandoff::query()->create([
            'id' => RandomIdentifier::new(),
            'source_conversion_id' => $sourceConversion->id,
            'visitor_id' => $visitor->id,
            'student_id' => $studentId,
            'person_id' => $personId,
            'authority_audit_event_id' => $authorityAuditEventId,
            'converted_by' => $actor->actorId,
            'correlation_id' => RandomIdentifier::new(),
        ]);
        // Match the audit entry to the bound downstream authority event clock.
        /** @var VisitorConversionHandoff $handoff */
        $handoff = VisitorConversionHandoff::query()->whereKey($handoff->id)->firstOrFail();
        $event = $this->audit->record($actor->actorId, 'crm.conversion.handoff', 'visitor_conversion_handoff', $handoff->id, null, [
            'visitor_id' => $visitor->id,
            'source_conversion_id' => $sourceConversion->id,
            'conversion_type' => 'student',
            'person_id' => $personId,
            'student_id' => $studentId,
            'status' => Visitor::STATUS_CONVERTED,
            'authority' => 'students',
            'authority_audit_event_id' => $authorityAuditEventId,
            'converted_at' => $handoff->converted_at?->toDateTimeString(),
            'conversion_time_basis' => $handoff->conversion_time_basis,
            'origin_branch_id' => $visitor->origin_branch_id,
            ...$this->branchScope($visitor->origin_branch_id),
            ...$this->branchProvenance('student', $downstreamId),
        ]);

        return [
            'conversion_id' => $handoff->id,
            'visitor_id' => $visitor->id,
            'status' => Visitor::STATUS_CONVERTED,
            'converted_at' => $handoff->converted_at?->toDateTimeString(),
            'conversion_time_basis' => $handoff->conversion_time_basis,
            'correlation_id' => $event->correlation_id,
        ];
    }

    private function closeOpenFollowups(Visitor $visitor, Actor $actor): void
    {
        $followups = VisitorFollowup::query()
            ->where('visitor_id', $visitor->id)
            ->where('status', VisitorFollowup::STATUS_OPEN)
            ->lockForUpdate()
            ->get();
        foreach ($followups as $followup) {
            $before = ['status' => $followup->status];
            $followup->forceFill([
                'status' => VisitorFollowup::STATUS_CANCELLED,
                'completed_by' => $actor->actorId,
                'completed_at' => now()->toDateTimeString(),
            ])->save();
            $after = [
                'status' => VisitorFollowup::STATUS_CANCELLED,
                'reason' => 'visitor_converted',
                'visitor_id' => $visitor->id,
                'origin_branch_id' => $visitor->origin_branch_id,
            ];
            $scope = $this->branchScope($visitor->origin_branch_id);
            if ($scope !== [] && UserAccount::query()->where('person_id', $followup->assigned_to)->where('account_state', UserAccount::STATE_ACTIVE)->exists()) {
                $after += $scope + [
                    'notification' => [
                        'recipient_actor_id' => $followup->assigned_to,
                        'source_type' => 'visitor_followup',
                        'source_id' => $followup->id,
                        'title' => 'CRM follow-up cancelled: visitor converted',
                        'severity' => 'info',
                        'dedupe_key' => 'crm.followup.converted.'.$followup->id,
                    ],
                ];
            }
            $this->audit->record($actor->actorId, 'crm.followup.transition', 'visitor_followup', $followup->id, $before, $after);
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

    /** @return array{originating_branch_id?: string, organization_id?: string} */
    private function branchProvenance(string $conversionType, string $downstreamId): array
    {
        $branchId = $conversionType === 'applicant'
            ? Applicant::query()->whereKey($downstreamId)->value('originating_branch_id')
            : Student::query()->whereKey($downstreamId)->value('originating_branch_id');
        $branchId = trim((string) ($branchId ?? ''));
        if ($branchId === '') {
            return [];
        }
        $topology = DB::table('branches as b')
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

        return $topology === null ? [] : [
            'originating_branch_id' => (string) $topology->branch_id,
            'organization_id' => (string) $topology->organization_id,
        ];
    }

    /** @return array{?string, ?string, ?string} */
    private function resolveDownstream(string $conversionType, string $downstreamEntity, string $downstreamId, Visitor $visitor): array
    {
        if ($conversionType === 'applicant') {
            if ($downstreamEntity !== 'applicant') {
                throw BusinessRejection::forCode('crm.conversion_downstream', 'an applicant conversion must reference an applicant');
            }
            /** @var Applicant|null $applicant */
            $applicant = Applicant::query()->whereKey($downstreamId)->lockForUpdate()->first();
            if ($applicant === null) {
                throw BusinessRejection::forCode('crm.downstream_missing', 'the applicant does not exist');
            }
            if (! in_array($applicant->lifecycle_state, [ApplicantLifecycle::STATE_PROSPECT, ApplicantLifecycle::STATE_APPLICANT, ApplicantLifecycle::STATE_ADMITTED], true)) {
                throw BusinessRejection::forCode('crm.downstream_inactive', 'the applicant is not in a convertible lifecycle state');
            }
            $this->assertDownstreamIdentityAndProvenance($visitor, $applicant->person_id, $applicant->originating_branch_id);

            return [$applicant->person_id, $applicant->id, null];
        }

        if ($conversionType === 'student') {
            if ($downstreamEntity !== 'student') {
                throw BusinessRejection::forCode('crm.conversion_downstream', 'a student conversion must reference a student');
            }
            /** @var Student|null $student */
            $student = Student::query()->whereKey($downstreamId)->lockForUpdate()->first();
            if ($student === null) {
                throw BusinessRejection::forCode('crm.downstream_missing', 'the student does not exist');
            }
            $latestStatus = StudentStatus::query()->where('student_id', $student->id)->orderByDesc('seq')->first();
            if ($latestStatus === null || ! in_array($latestStatus->status, [StudentStatusRegistry::STATUS_ACTIVE, StudentStatusRegistry::STATUS_SUSPENDED], true)) {
                throw BusinessRejection::forCode('crm.downstream_inactive', 'the student is not in a convertible lifecycle state');
            }
            $this->assertDownstreamIdentityAndProvenance($visitor, $student->person_id, $student->originating_branch_id);

            return [$student->person_id, null, $student->id];
        }

        throw BusinessRejection::forCode('crm.conversion_type', 'only authoritative applicant or student conversions are supported');
    }

    private function assertDownstreamIdentityAndProvenance(Visitor $visitor, ?string $personId, ?string $branchId): void
    {
        if ($personId === null || Person::query()->whereKey($personId)->where('verification_state', Person::VERIFICATION_VERIFIED)->doesntExist()) {
            throw BusinessRejection::forCode('crm.downstream_identity_unverified', 'the downstream record must belong to a verified person');
        }
        $branchId = trim((string) ($branchId ?? ''));
        if ($branchId === '') {
            throw BusinessRejection::forCode('crm.downstream_provenance_missing', 'the downstream conversion must carry an originating branch');
        }
        $branch = Branch::query()->whereKey($branchId)->first();
        $topology = DB::table('branches as b')
            ->join('campus_assignments as ca', 'ca.branch_id', '=', 'b.id')
            ->join('campuses as c', 'c.id', '=', 'ca.campus_id')
            ->join('organizations as o', 'o.id', '=', 'c.organization_id')
            ->where('b.id', $branchId)
            ->where('b.lifecycle_state', 'active')
            ->where('c.lifecycle_state', 'active')
            ->where('o.lifecycle_state', 'active')
            ->where('ca.effective_from', '<=', now()->toDateString())
            ->where(fn ($query) => $query->whereNull('ca.effective_to')->orWhere('ca.effective_to', '>', now()->toDateString()))
            ->exists();
        if ($branch === null || ! $topology) {
            throw BusinessRejection::forCode('crm.downstream_provenance_invalid', 'the downstream conversion branch must be operationally active');
        }
        $visitorBranchId = trim((string) ($visitor->origin_branch_id ?? ''));
        if ($visitorBranchId !== '' && $visitorBranchId !== $branchId) {
            throw BusinessRejection::forCode('crm.conversion_branch_mismatch', 'the downstream conversion belongs to a different originating branch');
        }
    }

    private function bindPerson(Visitor &$visitor, ?string $personId, string $updatedBy): void
    {
        if ($personId === null) {
            return;
        }
        if ($visitor->person_id !== null && $visitor->person_id !== $personId) {
            throw BusinessRejection::forCode('crm.conversion_person_mismatch', 'the converted record belongs to a different person than the visitor');
        }
        if ($visitor->person_id === null) {
            $visitor->forceFill(['person_id' => $personId, 'updated_by' => $updatedBy])->save();
        }
    }
}
