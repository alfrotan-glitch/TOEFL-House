<?php

declare(strict_types=1);

namespace App\Modules\Students\Queries;

use App\Modules\Academic\Models\ProgressionDecision;
use App\Modules\Students\Domain\StudentStatusRegistry;
use App\Modules\Students\Models\GuardianRelationship;
use App\Modules\Students\Models\Student;
use App\Modules\Students\Models\StudentHoldEvent;
use App\Modules\Students\Models\StudentStatus;
use Carbon\CarbonImmutable;
use Illuminate\Support\Facades\DB;

/**
 * The authoritative, read-only student learner lifecycle file. It composes
 * Student-owned history (status, guardians, branch transfers, holds,
 * communication preferences) with facts owned by other modules (Admissions,
 * Placement, Academic, Finance, Documents, Communication, Audit) without
 * ever mutating them.
 */
final class StudentLifecycleQuery
{
    /**
     * @param  list<string>|null  $financeObligationBranches
     * @param  list<string>|null  $financePaymentBranches
     * @return array<string, mixed>
     */
    public function for(Student $student, ?CarbonImmutable $asOf = null, bool $includeFinance = true, bool $includeGuardianReview = false, ?array $financeObligationBranches = null, ?array $financePaymentBranches = null): array
    {
        $day = ($asOf ?? CarbonImmutable::now())->startOfDay()->toDateString();
        $student->load([
            'person', 'admissionDecision.applicant', 'placementProfile',
            'statuses' => fn ($query) => $query->orderBy('seq'),
            'branchTransfers', 'holdEvents', 'communicationPreferences',
            'originatingBranch', 'currentHomeBranch',
        ]);

        /** @var StudentStatus|null $currentStatus */
        $currentStatus = $student->statuses()
            ->where('effective_from', '<=', $day)
            ->orderByDesc('seq')
            ->first();
        $openHold = $this->openHold($student->id, $day);

        $guardians = GuardianRelationship::query()
            ->where('student_id', $student->id)
            ->where('lifecycle_state', 'active')
            ->where('verification_state', 'verified')
            ->where('effective_from', '<=', $day)
            ->where(fn ($query) => $query->whereNull('effective_to')->orWhere('effective_to', '>', $day))
            ->orderBy('id')
            ->get(['id', 'guardian_person_id', 'relationship', 'permissions']);
        $guardianRelationships = $includeGuardianReview
            ? GuardianRelationship::query()
                ->where('student_id', $student->id)
                ->where('lifecycle_state', 'active')
                ->where('effective_from', '<=', $day)
                ->where(fn ($query) => $query->whereNull('effective_to')->orWhere('effective_to', '>', $day))
                ->orderBy('id')
                ->get(['id', 'guardian_person_id', 'relationship', 'permissions', 'verification_state'])
            : collect();

        return [
            'student_id' => trim((string) $student->id),
            'student_code' => $student->student_code,
            'person' => $student->person === null ? null : [
                'person_id' => trim((string) $student->person_id),
                'legal_name' => $student->person->legal_name,
                'verified' => ($student->person->verification_state ?? null) === 'verified',
            ],
            'admission' => $student->admissionDecision === null ? null : [
                'decision_id' => trim((string) $student->admissionDecision->id),
                'applicant_id' => trim((string) $student->admissionDecision->applicant_id),
                'program_interest' => $student->admissionDecision->applicant?->program_interest,
                'outcome' => $student->admissionDecision->outcome,
                'lifecycle_state' => $student->admissionDecision->lifecycle_state,
                'reason' => $student->admissionDecision->reason,
                'evidence_ref' => $student->admissionDecision->evidence_ref,
                'initiator_id' => trim((string) $student->admissionDecision->initiator_id),
                'reviewer_id' => trim((string) ($student->admissionDecision->reviewer_id ?? '')),
                'approver_id' => trim((string) ($student->admissionDecision->approver_id ?? '')),
                'created_at' => $student->admissionDecision->created_at,
            ],
            'originating_branch_id' => trim((string) ($student->originating_branch_id ?? '')),
            'current_home_branch_id' => trim((string) ($student->current_home_branch_id ?? '')),
            'branch_provenance' => [
                'originating' => $student->originatingBranch === null ? null : [
                    'id' => trim((string) $student->originatingBranch->id),
                    'name' => $student->originatingBranch->name,
                ],
                'current_home' => $student->currentHomeBranch === null ? null : [
                    'id' => trim((string) $student->currentHomeBranch->id),
                    'name' => $student->currentHomeBranch->name,
                ],
            ],
            'placement_profile_id' => trim((string) ($student->placement_profile_id ?? '')),
            'placement' => $student->placementProfile === null ? null : [
                'id' => trim((string) $student->placementProfile->id),
                'lifecycle_state' => $student->placementProfile->lifecycle_state,
                'recommended_level_id' => trim((string) ($student->placementProfile->recommended_level_id ?? '')),
                'overall_cefr_ref' => $student->placementProfile->overall_cefr_ref,
            ],
            'status' => $currentStatus?->status,
            'available_status_transitions' => $currentStatus === null ? [] : StudentStatusRegistry::nextStatuses($currentStatus->status),
            'status_history' => $student->statuses
                ->filter(fn (StudentStatus $status): bool => (string) $status->effective_from <= $day)
                ->map(fn (StudentStatus $status): array => [
                'id' => trim((string) $status->id),
                'status' => $status->status,
                'effective_from' => $status->effective_from,
                'reason' => $status->reason,
                'actor_id' => trim((string) $status->actor_id),
            ])->all(),
            'holds' => [
                'open' => $openHold,
                'history' => $student->holdEvents
                    ->filter(fn (StudentHoldEvent $event): bool => (string) $event->effective_from <= $day)
                    ->map(fn (StudentHoldEvent $event): array => [
                    'id' => trim((string) $event->id),
                    'action' => $event->action,
                    'effective_from' => $event->effective_from,
                    'reason' => $event->reason,
                    'actor_id' => trim((string) $event->actor_id),
                ])->all(),
            ],
            'branch_transfers' => $student->branchTransfers
                ->filter(static fn ($transfer): bool => (string) $transfer->effective_from <= $day)
                ->map(static fn ($transfer): array => [
                'id' => trim((string) $transfer->id),
                'from_branch_id' => trim((string) ($transfer->from_branch_id ?? '')),
                'to_branch_id' => trim((string) $transfer->to_branch_id),
                'effective_from' => $transfer->effective_from,
                'reason' => $transfer->reason,
                'transferred_by' => trim((string) $transfer->transferred_by),
            ])->all(),
            'guardians' => $guardians->map(static fn (GuardianRelationship $relationship): array => [
                'relationship_id' => trim((string) $relationship->id),
                'guardian_person_id' => trim((string) $relationship->guardian_person_id),
                'relationship' => $relationship->relationship,
                'permissions' => $relationship->permissions ?? [],
            ])->all(),
            'guardian_relationships' => $guardianRelationships->map(static fn (GuardianRelationship $relationship): array => [
                'relationship_id' => trim((string) $relationship->id),
                'guardian_person_id' => trim((string) $relationship->guardian_person_id),
                'relationship' => $relationship->relationship,
                'permissions' => $relationship->permissions ?? [],
                'verification_state' => $relationship->verification_state,
            ])->all(),
            'communication_preferences' => $student->communicationPreferences->map(static fn ($preference): array => [
                'channel' => $preference->channel,
                'enabled' => (bool) $preference->enabled,
            ])->all(),
            'enrollments' => $this->enrollments($student->id),
            'attendance' => $this->attendanceSummary($student->id),
            'assessment_results' => $this->assessmentResults($student->id),
            'progression_decisions' => ProgressionDecision::query()
                ->where('student_id', $student->id)
                ->orderByDesc('created_at')
                ->limit(50)
                ->get()
                ->map(static fn (ProgressionDecision $decision): array => [
                    'id' => trim((string) $decision->id),
                    'class_id' => trim((string) $decision->class_id),
                    'outcome' => $decision->outcome,
                    'lifecycle_state' => $decision->lifecycle_state,
                    'reason' => $decision->reason,
                ])->all(),
            'obligations' => $includeFinance ? $this->obligations($student->id, $financeObligationBranches) : [],
            'payments' => $includeFinance ? $this->payments($student->id, $financePaymentBranches) : [],
            'documents' => $this->documents($student->person_id),
            'messages' => $this->messages($student->person_id),
            'audit_events' => DB::table('audit_events')
                ->where('target_type', 'student')
                ->where('target_id', $student->id)
                ->orderByDesc('occurred_at')
                ->limit(50)
                ->get(['id', 'actor_id', 'operation', 'correlation_id', 'occurred_at']),
            'workflow' => $this->workflow($student, $currentStatus?->status, $openHold, $includeGuardianReview, $day),
        ];
    }

    /** @return list<array<string, mixed>> */
    private function enrollments(string $studentId): array
    {
        return array_values(DB::table('enrollments as e')
            ->leftJoin('classes as c', 'c.id', '=', 'e.class_id')
            ->leftJoin('academic_periods as ap', 'ap.id', '=', 'c.period_id')
            ->leftJoin('offerings as o', 'o.id', '=', 'e.offering_id')
            ->where('e.student_id', $studentId)
            ->orderByDesc('e.created_at')
            ->limit(50)
            ->get([
                'e.id', 'e.class_id', 'e.offering_id', 'e.lifecycle_state',
                'e.originating_branch_id', 'e.current_home_branch_id',
                'c.program_version_id', 'c.period_id', 'ap.name as period_name',
            ])
            ->map(static fn ($row): array => [
                'id' => trim((string) $row->id),
                'class_id' => trim((string) $row->class_id),
                'offering_id' => trim((string) ($row->offering_id ?? '')),
                'lifecycle_state' => $row->lifecycle_state,
                'program_version_id' => trim((string) ($row->program_version_id ?? '')),
                'period_id' => trim((string) ($row->period_id ?? '')),
                'period_name' => $row->period_name,
            ])
            ->all());
    }

    /** @return array{present: int, absent: int, late: int, excused: int} */
    private function attendanceSummary(string $studentId): array
    {
        $rows = DB::table('attendance_facts as af')
            ->join('enrollments as e', 'e.id', '=', 'af.enrollment_id')
            ->where('e.student_id', $studentId)
            ->selectRaw('af.status, count(*) as total')
            ->groupBy('af.status')
            ->pluck('total', 'status');

        return [
            'present' => (int) ($rows['present'] ?? 0),
            'absent' => (int) ($rows['absent'] ?? 0),
            'late' => (int) ($rows['late'] ?? 0),
            'excused' => (int) ($rows['excused'] ?? 0),
        ];
    }

    /** @return list<array<string, mixed>> */
    private function assessmentResults(string $studentId): array
    {
        return array_values(DB::table('assessment_results as ar')
            ->join('assessment_attempts as aa', 'aa.id', '=', 'ar.attempt_id')
            ->join('enrollments as e', 'e.id', '=', 'aa.enrollment_id')
            ->where('e.student_id', $studentId)
            ->orderByDesc('ar.created_at')
            ->limit(50)
            ->get([
                'ar.id', 'ar.attempt_id', 'ar.score', 'ar.lifecycle_state',
                'ar.scored_by', 'ar.moderated_by', 'ar.approved_by', 'ar.released_by',
                'aa.kind', 'aa.evidence_ref',
            ])
            ->map(static fn ($row): array => [
                'id' => trim((string) $row->id),
                'attempt_id' => trim((string) $row->attempt_id),
                'kind' => $row->kind,
                'score' => $row->score,
                'lifecycle_state' => $row->lifecycle_state,
                'evidence_ref' => $row->evidence_ref,
                'scored_by' => trim((string) $row->scored_by),
                'released_by' => trim((string) ($row->released_by ?? '')),
            ])
            ->all());
    }

    /**
     * @param list<string>|null $visibleBranches
     * @return list<array<string, mixed>>
     */
    private function obligations(string $studentId, ?array $visibleBranches = null): array
    {
        $query = DB::table('obligations')->where('student_id', $studentId);
        $this->scopeFinanceRows($query, $visibleBranches);

return array_values(
            $query
                ->orderByDesc('created_at')
                ->limit(50)
                ->get(['id', 'period_id', 'source', 'original_amount', 'reason', 'originating_branch_id', 'current_home_branch_id', 'created_at'])
                ->map(static fn ($row): array => [
                    'id' => trim((string) $row->id),
                    'period_id' => trim((string) $row->period_id),
                    'source' => $row->source,
                    'original_amount' => $row->original_amount,
                    'reason' => $row->reason,
                    'originating_branch_id' => trim((string) ($row->originating_branch_id ?? '')),
                    'current_home_branch_id' => trim((string) ($row->current_home_branch_id ?? '')),
                    'created_at' => $row->created_at,
                ])
                ->all()
        );
    }

    /**
     * @param list<string>|null $visibleBranches
     * @return list<array<string, mixed>>
     */
    private function payments(string $studentId, ?array $visibleBranches = null): array
    {
        $query = DB::table('payments')->where('student_id', $studentId);
        $this->scopeFinanceRows($query, $visibleBranches);

        return array_values($query
            ->orderByDesc('created_at')
            ->limit(50)
            ->get(['id', 'period_id', 'amount', 'method', 'payer_ref', 'received_on', 'originating_branch_id', 'current_home_branch_id', 'created_at'])
            ->map(static fn ($row): array => [
                'id' => trim((string) $row->id),
                'period_id' => trim((string) $row->period_id),
                'amount' => $row->amount,
                'method' => $row->method,
                'payer_ref' => $row->payer_ref,
                'received_on' => $row->received_on,
                'originating_branch_id' => trim((string) ($row->originating_branch_id ?? '')),
                'current_home_branch_id' => trim((string) ($row->current_home_branch_id ?? '')),
            ])
            ->all());
    }

    /**
     * @param \Illuminate\Database\Query\Builder $query
     * @param list<string>|null $visibleBranches
     */
    private function scopeFinanceRows($query, ?array $visibleBranches): void
    {
        if ($visibleBranches === null) {
            return;
        }

        $query->where(function ($scope) use ($visibleBranches): void {
            $scope->whereIn('current_home_branch_id', $visibleBranches)
                ->orWhere(function ($origin) use ($visibleBranches): void {
                    $origin->whereNull('current_home_branch_id')
                        ->whereIn('originating_branch_id', $visibleBranches);
                });
        });
    }

    /** @return list<array<string, mixed>> */
    private function documents(string $personId): array
    {
        return array_values(DB::table('documents as d')
            ->leftJoin('document_versions as dv', function ($join): void {
                $join->on('dv.document_id', '=', 'd.id')
                    ->whereRaw('dv.version_no = (select max(dv2.version_no) from document_versions dv2 where dv2.document_id = d.id)');
            })
            ->where('d.subject_person_id', $personId)
            ->orderByDesc('d.created_at')
            ->limit(50)
            ->get(['d.id', 'd.title', 'd.lifecycle_state', 'dv.version_no', 'dv.content_hash'])
            ->map(static fn ($row): array => [
                'id' => trim((string) $row->id),
                'title' => $row->title,
                'lifecycle_state' => $row->lifecycle_state,
                'version_no' => $row->version_no,
                'content_hash' => $row->content_hash,
            ])
            ->all());
    }

    /** @return list<array<string, mixed>> */
    private function messages(string $personId): array
    {
        return array_values(DB::table('messages')
            ->where('subject_person_id', $personId)
            ->orderByDesc('created_at')
            ->limit(50)
            ->get(['id', 'purpose_id', 'channel', 'lifecycle_state', 'delivery_ref', 'created_at'])
            ->map(static fn ($row): array => [
                'id' => trim((string) $row->id),
                'purpose_id' => trim((string) $row->purpose_id),
                'channel' => $row->channel,
                'lifecycle_state' => $row->lifecycle_state,
                'delivery_ref' => trim((string) ($row->delivery_ref ?? '')),
            ])
            ->all());
    }

    private function openHold(string $studentId, string $day): bool
    {
        /** @var StudentHoldEvent|null $latest */
        $latest = StudentHoldEvent::query()
            ->where('student_id', $studentId)
            ->where('effective_from', '<=', $day)
            ->orderByDesc('seq')
            ->first();

        return $latest?->action === 'freeze';
    }

    /**
     * @return list<array<string, mixed>>
     */
    private function workflow(Student $student, ?string $currentStatus, bool $openHold, bool $includeGuardianReview, string $day): array
    {
        $items = [];

        $unverifiedGuardians = $includeGuardianReview
            ? GuardianRelationship::query()
                ->where('student_id', $student->id)
                ->where('lifecycle_state', 'active')
                ->where('verification_state', 'unverified')
                ->where('effective_from', '<=', $day)
                ->where(fn ($query) => $query->whereNull('effective_to')->orWhere('effective_to', '>', $day))
                ->count()
            : 0;
        if ($unverifiedGuardians > 0) {
            $items[] = ['type' => 'guardian_verification', 'label' => "{$unverifiedGuardians} guardian relationship(s) require verification"];
        }
        if ($openHold) {
            $items[] = ['type' => 'hold_open', 'label' => 'Student has an open freeze; resume is required'];
        }
        if (in_array($currentStatus, ['suspended', 'withdrawn'], true)) {
            $items[] = ['type' => 'reactivation_pending', 'label' => 'Student needs approval to reactivate'];
        }
        $activeEnrollments = DB::table('enrollments')
            ->where('student_id', $student->id)
            ->where('lifecycle_state', 'active')
            ->count();
        if ($activeEnrollments > 0) {
            $items[] = ['type' => 'enrollment_active', 'label' => "Student has {$activeEnrollments} active enrollment(s)"];
        }
        $openAppeals = DB::table('academic_appeals')
            ->where('student_id', $student->id)
            ->whereIn('lifecycle_state', ['open', 'assigned', 'investigating', 'escalated'])
            ->count();
        if ($openAppeals > 0) {
            $items[] = ['type' => 'appeal_open', 'label' => "Student has {$openAppeals} open academic appeal(s)"];
        }
        if ($student->placement_profile_id !== null) {
            $items[] = ['type' => 'placement_linked', 'label' => 'Student carries a linked placement evidence profile'];
        }

        return $items;
    }
}
