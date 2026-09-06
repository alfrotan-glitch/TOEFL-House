<?php

declare(strict_types=1);

namespace App\Http\Controllers\Api;

use App\Http\Controllers\Controller;
use App\Modules\Academic\Commands\MaintainTeacherAssignment;
use App\Modules\Academic\Commands\MaintainTeacherProfile;
use App\Modules\Academic\Models\ClassModel;
use App\Modules\Academic\Models\TeacherProfile;
use App\Modules\Academic\Models\TeacherQualification;
use App\Modules\Academic\Models\TeacherAssignment;
use App\Modules\Academic\Models\TeacherAssignmentSkill;
use App\Modules\Academic\Models\TeacherWorkloadLimit;
use App\Modules\Hr\Models\Employment;
use App\Modules\Hr\Models\Leave;
use Carbon\CarbonImmutable;
use Illuminate\Http\JsonResponse;
use Illuminate\Http\Request;

/**
 * Canonical Teacher workspace transport. It returns server-derived profile,
 * capability, assignment, qualification, availability, and provenance facts;
 * every mutation delegates to MaintainTeacherProfile or the Academic Teacher
 * assignment command surface.
 */
final class TeacherApiController extends Controller
{
    public function workspace(): JsonResponse
    {
        $actor = $this->actor();
        $own = TeacherProfile::query()->where('person_id', $actor->actorId)->with(['person', 'employment', 'statuses', 'qualifications', 'branchAuthorizations', 'skillAuthorities', 'availabilities', 'workloadLimits'])->first();
        $branchIds = $this->authorizedBranches(MaintainTeacherProfile::CAPABILITY);
        $query = TeacherProfile::query()->with(['person', 'employment', 'statuses', 'qualifications', 'branchAuthorizations', 'skillAuthorities', 'availabilities', 'workloadLimits']);
        if ($own !== null) {
            $query->where(function ($scoped) use ($branchIds, $actor): void {
                $scoped->where('person_id', $actor->actorId);
                if ($branchIds !== []) {
                    $scoped->orWhereIn('current_home_branch_id', $branchIds)->orWhereHas('branchAuthorizations', function ($authorization) use ($branchIds): void {
                        $authorization->whereIn('branch_id', $branchIds)->where('lifecycle_state', 'active')->where('effective_from', '<=', now()->toDateString())->where(function ($valid): void {
                            $valid->whereNull('effective_to')->orWhere('effective_to', '>', now()->toDateString());
                        });
                    });
                }
            });
        } elseif ($branchIds !== []) {
            $query->whereIn('current_home_branch_id', $branchIds);
        } else {
            $query->whereRaw('1 = 0');
        }
        $profiles = $query->orderBy('id')->limit(300)->get();
        $profileIds = $profiles->pluck('id')->all();
        $assignments = $profileIds === [] ? collect() : TeacherAssignment::query()->whereIn('teacher_profile_id', $profileIds)->with('skills')->orderByDesc('effective_from')->get()->groupBy('teacher_profile_id');

        return response()->json([
            'data' => [
                'viewer' => ['person_id' => $actor->actorId, 'teacher_profile_id' => $own?->id],
                'capabilities' => [
                    'manage' => $branchIds !== [],
                    'approve' => $this->authorizedBranches(MaintainTeacherProfile::CAPABILITY_APPROVE) !== [],
                    'is_teacher' => $own !== null,
                ],
                'profiles' => $profiles->map(function (TeacherProfile $profile) use ($assignments): array {
                    $rows = $assignments->get($profile->id, collect());
                    /** @var Employment|null $employment */
                    $employment = $profile->employment;
                    $employmentState = $employment !== null ? (string) $employment->lifecycle_state : 'unknown';
                    $onLeave = Leave::query()->where('employment_id', $profile->employment_id)->where('lifecycle_state', 'approved')->where('date_from', '<=', now()->toDateString())->where('date_to', '>=', now()->toDateString())->exists();
                    $effectiveState = $profile->lifecycle_state !== TeacherProfile::STATE_ACTIVE ? 'profile_'.$profile->lifecycle_state : ($employmentState !== 'active' ? 'employment_'.$employmentState : ($onLeave ? 'on_leave' : 'operational'));
                    /** @var \App\Modules\Identity\Models\Person|null $profilePerson */
                    $profilePerson = $profile->person;
                    return [
                        'id' => (string) $profile->id,
                        'person_id' => (string) $profile->person_id,
                        'legal_name' => $profilePerson !== null ? (string) $profilePerson->legal_name : '',
                        'employment_id' => (string) $profile->employment_id,
                        'employment_state' => $employmentState,
                        'effective_state' => $effectiveState,
                        'lifecycle_state' => (string) $profile->lifecycle_state,
                        'allowed_transitions' => TeacherProfile::allowedTransitions((string) $profile->lifecycle_state),
                        'status_history' => $profile->statuses->map(static fn ($status): array => [
                            'status' => (string) $status->status,
                            'effective_from' => (string) $status->effective_from,
                            'reason' => (string) $status->reason,
                            'actor_id' => (string) $status->actor_id,
                        ])->values()->all(),
                        'professional_title' => (string) ($profile->professional_title ?? ''),
                        'profile_summary' => $profile->profile_summary,
                        'originating_branch_id' => (string) $profile->originating_branch_id,
                        'current_home_branch_id' => (string) $profile->current_home_branch_id,
                        'qualifications' => $profile->qualifications->map(static fn (TeacherQualification $qualification): array => [
                            'id' => (string) $qualification->id,
                            'type' => (string) $qualification->qualification_type,
                            'title' => (string) $qualification->title,
                            'issuer' => (string) $qualification->issuer,
                            'state' => (string) $qualification->lifecycle_state,
                            'valid_from' => $qualification->valid_from,
                            'valid_to' => $qualification->valid_to,
                            'evidence_ref' => (string) $qualification->evidence_ref,
                        ])->values()->all(),
                        'branch_authorizations' => $profile->branchAuthorizations->map(static fn ($authorization): array => [
                            'id' => (string) $authorization->id,
                            'branch_id' => (string) $authorization->branch_id,
                            'state' => (string) $authorization->lifecycle_state,
                            'effective_from' => (string) $authorization->effective_from,
                            'effective_to' => $authorization->effective_to,
                        ])->values()->all(),
                        'skill_authorities' => $profile->skillAuthorities->map(static fn ($authority): array => [
                            'id' => (string) $authority->id,
                            'skill_id' => (string) $authority->skill_id,
                            'branch_id' => (string) $authority->branch_id,
                            'kind' => (string) $authority->authority_kind,
                            'state' => (string) $authority->lifecycle_state,
                            'effective_from' => (string) $authority->effective_from,
                            'effective_to' => $authority->effective_to,
                            'evidence_ref' => (string) $authority->evidence_ref,
                        ])->values()->all(),
                        'availability' => $profile->availabilities->map(static fn ($availability): array => [
                            'id' => (string) $availability->id,
                            'branch_id' => (string) $availability->branch_id,
                            'weekday' => (int) $availability->weekday,
                            'starts_at' => (string) $availability->starts_at,
                            'ends_at' => (string) $availability->ends_at,
                            'effective_from' => (string) $availability->effective_from,
                            'effective_to' => $availability->effective_to,
                            'state' => (string) $availability->lifecycle_state,
                        ])->values()->all(),
                        'workload_limits' => $profile->workloadLimits->map(static fn (TeacherWorkloadLimit $limit): array => [
                            'id' => (string) $limit->id,
                            'branch_id' => (string) $limit->branch_id,
                            'max_hours_per_week' => (string) $limit->max_hours_per_week,
                            'effective_from' => (string) $limit->effective_from,
                            'effective_to' => $limit->effective_to,
                            'state' => (string) $limit->lifecycle_state,
                            'evidence_ref' => (string) $limit->evidence_ref,
                        ])->values()->all(),
                        'assignments' => $rows->map(static fn (TeacherAssignment $assignment): array => [
                            'id' => (string) $assignment->id,
                            'class_id' => (string) $assignment->class_id,
                            'teacher_person_id' => (string) $assignment->teacher_person_id,
                            'branch_id' => $assignment->branch_id,
                            'campus_id' => $assignment->campus_id,
                            'organization_id' => $assignment->organization_id,
                            'identity_consistent' => (string) $assignment->teacher_person_id === (string) $profile->person_id,
                            'lifecycle_state' => $assignment->lifecycle_state,
                            'effective_from' => (string) $assignment->effective_from,
                            'effective_to' => $assignment->effective_to,
                            'assigned_by' => $assignment->assigned_by,
                            'skills' => $assignment->skills->map(static fn (TeacherAssignmentSkill $skill): array => [
                                'id' => (string) $skill->id,
                                'skill_id' => (string) $skill->skill_id,
                            ])->values()->all(),
                        ])->values()->all(),
                    ];
                })->values()->all(),
            ],
        ]);
    }

    public function register(Request $request): JsonResponse
    {
        $input = $request->validate(['employment_id' => ['required', 'string'], 'professional_title' => ['required', 'string', 'max:160'], 'profile_summary' => ['nullable', 'string', 'max:4000']]);
        $result = app(MaintainTeacherProfile::class)->register($this->actor(), Employment::query()->findOrFail((string) $input['employment_id']), $input['professional_title'], $input['profile_summary'] ?? null, $this->idempotencyKey('academic.teacher.register'));
        return response()->json(['status' => 'registered', ...$result], 201);
    }

    public function qualification(Request $request, string $profileId): JsonResponse
    {
        $input = $request->validate(['qualification_type' => ['required', 'string', 'max:120'], 'title' => ['required', 'string', 'max:255'], 'issuer' => ['required', 'string', 'max:255'], 'evidence_ref' => ['required', 'string', 'max:255'], 'valid_from' => ['nullable', 'date'], 'valid_to' => ['nullable', 'date']]);
        $result = app(MaintainTeacherProfile::class)->addQualification($this->actor(), TeacherProfile::query()->findOrFail($profileId), $input['qualification_type'], $input['title'], $input['issuer'], $input['evidence_ref'], $input['valid_from'] ?? null, $input['valid_to'] ?? null, $this->idempotencyKey('academic.teacher.qualification.add'));
        return response()->json(['status' => 'recorded', ...$result], 201);
    }

    public function verifyQualification(string $qualificationId): JsonResponse
    {
        $result = app(MaintainTeacherProfile::class)->verifyQualification($this->actor(), TeacherQualification::query()->findOrFail($qualificationId), $this->idempotencyKey('academic.teacher.qualification.verify'));
        return response()->json(['status' => 'verified', ...$result]);
    }

    public function transition(Request $request, string $profileId): JsonResponse
    {
        $input = $request->validate(['to_state' => ['required', 'in:active,suspended,retired'], 'reason' => ['required', 'string', 'max:1000']]);
        $result = app(MaintainTeacherProfile::class)->transition($this->actor(), TeacherProfile::query()->findOrFail($profileId), $input['to_state'], $input['reason'], $this->idempotencyKey('academic.teacher.profile.transition'));
        return response()->json(['status' => 'transitioned', ...$result]);
    }

    public function transfer(Request $request, string $profileId): JsonResponse
    {
        $input = $request->validate(['branch_id' => ['required', 'string'], 'effective_from' => ['required', 'date'], 'reason' => ['required', 'string', 'max:1000']]);
        $result = app(MaintainTeacherProfile::class)->transferBranch($this->actor(), TeacherProfile::query()->findOrFail($profileId), $input['branch_id'], $input['effective_from'], $input['reason'], $this->idempotencyKey('academic.teacher.branch.transfer'));
        return response()->json(['status' => 'transferred', ...$result]);
    }

    public function branch(Request $request, string $profileId): JsonResponse
    {
        $input = $request->validate(['branch_id' => ['required', 'string'], 'effective_from' => ['required', 'date'], 'effective_to' => ['nullable', 'date'], 'reason' => ['required', 'string', 'max:1000']]);
        $result = app(MaintainTeacherProfile::class)->authorizeBranch($this->actor(), TeacherProfile::query()->findOrFail($profileId), $input['branch_id'], $input['effective_from'], $input['effective_to'] ?? null, $input['reason'], $this->idempotencyKey('academic.teacher.branch.authorize'));
        return response()->json(['status' => 'authorized', ...$result], 201);
    }

    public function skill(Request $request, string $profileId): JsonResponse
    {
        $input = $request->validate(['skill_id' => ['required', 'string'], 'branch_id' => ['required', 'string'], 'authority_kind' => ['required', 'in:teach,assess,moderate'], 'effective_from' => ['required', 'date'], 'effective_to' => ['nullable', 'date'], 'evidence_ref' => ['required', 'string', 'max:255']]);
        $result = app(MaintainTeacherProfile::class)->authorizeSkill($this->actor(), TeacherProfile::query()->findOrFail($profileId), $input['skill_id'], $input['branch_id'], $input['authority_kind'],  $input['effective_from'], $input['effective_to'] ?? null, $input['evidence_ref'], $this->idempotencyKey('academic.teacher.skill.authorize'));
        return response()->json(['status' => 'authorized', ...$result], 201);
    }

    public function availability(Request $request, string $profileId): JsonResponse
    {
        $input = $request->validate(['branch_id' => ['required', 'string'], 'weekday' => ['required', 'integer', 'between:1,7'], 'starts_at' => ['required', 'date_format:H:i'], 'ends_at' => ['required', 'date_format:H:i'], 'effective_from' => ['required', 'date'], 'effective_to' => ['nullable', 'date']]);
        $result = app(MaintainTeacherProfile::class)->declareAvailability($this->actor(), TeacherProfile::query()->findOrFail($profileId), $input['branch_id'], (int) $input['weekday'], $input['starts_at'], $input['ends_at'], $input['effective_from'], $input['effective_to'] ?? null, 'available', $this->idempotencyKey('academic.teacher.availability.declare'));
        return response()->json(['status' => 'declared', ...$result], 201);
    }

    public function workload(Request $request, string $profileId): JsonResponse
    {
        $input = $request->validate(['branch_id' => ['required', 'string'], 'max_hours_per_week' => ['required', 'numeric', 'gt:0', 'max:999.99'], 'effective_from' => ['required', 'date'], 'effective_to' => ['nullable', 'date'], 'evidence_ref' => ['required', 'string', 'max:255']]);
        $result = app(MaintainTeacherProfile::class)->setWorkloadLimit($this->actor(), TeacherProfile::query()->findOrFail($profileId), $input['branch_id'], (string) $input['max_hours_per_week'], $input['effective_from'], $input['effective_to'] ?? null, $input['evidence_ref'], $this->idempotencyKey('academic.teacher.workload.set'));
        return response()->json(['status' => 'set', ...$result], 201);
    }

    public function assign(Request $request): JsonResponse
    {
        $input = $request->validate(['class_id' => ['required', 'string'], 'teacher_person_id' => ['required', 'string'], 'effective_from' => ['required', 'date'], 'effective_to' => ['nullable', 'date', 'after:effective_from']]);
        $result = app(MaintainTeacherAssignment::class)->assignTeacher($this->actor(), ClassModel::query()->findOrFail((string) $input['class_id']), $input['teacher_person_id'], CarbonImmutable::parse($input['effective_from']), ($input['effective_to'] ?? '') !== '' ? CarbonImmutable::parse($input['effective_to']) : null, $this->idempotencyKey('academic.teacher.assign'));
        return response()->json(['status' => 'assigned', ...$result], 201);
    }

    public function endAssignment(Request $request, string $assignmentId): JsonResponse
    {
        $input = $request->validate(['effective_to' => ['required', 'date'], 'reason' => ['required', 'string', 'max:1000']]);
        $result = app(MaintainTeacherAssignment::class)->endAssignment($this->actor(), TeacherAssignment::query()->findOrFail($assignmentId), CarbonImmutable::parse($input['effective_to']), $input['reason'], $this->idempotencyKey('academic.teacher.end'));
        return response()->json(['status' => 'ended', ...$result]);
    }

    public function extendAssignment(Request $request, string $assignmentId): JsonResponse
    {
        $input = $request->validate(['effective_to' => ['required', 'date'], 'reason' => ['required', 'string', 'max:1000']]);
        $result = app(MaintainTeacherAssignment::class)->extendAssignment($this->actor(), TeacherAssignment::query()->findOrFail($assignmentId), CarbonImmutable::parse($input['effective_to']), $input['reason'], $this->idempotencyKey('academic.teacher.extend'));
        return response()->json(['status' => 'extended', ...$result]);
    }

    public function handover(Request $request, string $assignmentId): JsonResponse
    {
        $input = $request->validate(['successor_teacher_person_id' => ['required', 'string'], 'handover_on' => ['required', 'date'], 'reason' => ['required', 'string', 'max:1000']]);
        $result = app(MaintainTeacherAssignment::class)->handoverAssignment($this->actor(), TeacherAssignment::query()->findOrFail($assignmentId), $input['successor_teacher_person_id'], CarbonImmutable::parse($input['handover_on']), $input['reason'], $this->idempotencyKey('academic.teacher.handover'));
        return response()->json(['status' => 'handed_over', ...$result]);
    }

    public function assignSkill(Request $request, string $assignmentId): JsonResponse
    {
        $input = $request->validate(['skill_id' => ['required', 'string']]);
        $result = app(MaintainTeacherAssignment::class)->assignSkill($this->actor(), TeacherAssignment::query()->findOrFail($assignmentId), $input['skill_id'], $this->idempotencyKey('academic.teacher.assign_skill'));
        return response()->json(['status' => 'attributed', ...$result], 201);
    }
}
