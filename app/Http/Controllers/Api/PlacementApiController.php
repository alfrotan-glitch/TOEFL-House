<?php

declare(strict_types=1);

namespace App\Http\Controllers\Api;

use App\Http\Controllers\Controller;
use App\Modules\Academic\Commands\ManageAcademicAppeal;
use App\Modules\Academic\Domain\RecordBranch;
use App\Modules\Academic\Placement\Commands\DecidePlacement;
use App\Modules\Academic\Placement\Commands\ManagePlacementProfile;
use App\Modules\Academic\Placement\Commands\RecommendPlacement;
use App\Modules\Academic\Placement\Commands\ScorePlacement;
use App\Modules\Academic\Placement\Models\PlacementAttempt;
use App\Modules\Academic\Placement\Models\PlacementProfile;
use App\Modules\Academic\Placement\Models\PlacementSectionResult;
use App\Modules\Academic\Placement\Models\PlacementTest;
use App\Modules\Academic\Placement\Models\PlacementTestVersion;
use App\Modules\Academic\Placement\Queries\AcademicEligibilitySnapshotQuery;
use App\Modules\Academic\Placement\Queries\PlacementFinanceLinkQuery;
use App\Modules\Academic\Placement\Queries\PlacementProfileQuery;
use App\Support\Authorization\ActorBranches;
use Illuminate\Http\JsonResponse;
use Illuminate\Http\Request;

/**
 * JSON interface for the Placement Decision System. Every mutation
 * delegates to the Academic Placement commands, so authorization,
 * idempotency, audit, anti-tamper and business rules remain server-side.
 */
final class PlacementApiController extends Controller
{
    public function tests(): JsonResponse
    {
        $tests = [];
        if ($this->hasReadAuthority()) {
            $visible = $this->visibleBranches();
            $tests = PlacementTest::query()
                ->where(function ($query) use ($visible): void {
                    $query->whereIn('originating_branch_id', $visible)
                        ->orWhereNull('originating_branch_id');
                })
                ->orderBy('name')->get([
                    'id', 'key', 'name', 'program_version_id', 'total_time_minutes',
                    'component_weights', 'lifecycle_state', 'originating_branch_id',
                ]);
        }

        return response()->json(['tests' => $tests]);
    }

    public function versions(): JsonResponse
    {
        return response()->json([
            'versions' => PlacementTestVersion::query()->orderByDesc('id')->limit(200)->get([
                'id', 'placement_test_id', 'version_no', 'summary', 'lifecycle_state', 'published_at',
            ]),
        ]);
    }

    public function profiles(Request $request): JsonResponse
    {
        $profiles = [];
        if ($this->hasReadAuthority()) {
            $branches = app(ActorBranches::class);
            $actor = $this->actor();
            $profiles = app(PlacementProfileQuery::class)->search(
                (string) $request->query('term', ''),
                (string) $request->query('lifecycle_state', ''),
                (string) $request->query('program_version_id', ''),
            )->filter(fn ($profile): bool => $branches->allows($actor, RecordBranch::placementProfileBranch($profile)))->values();
        }

        return response()->json(['profiles' => $profiles]);
    }

    public function show(string $profileId): JsonResponse
    {
        $profile = PlacementProfile::query()->findOrFail($profileId);
        $this->requireBranchVisible(RecordBranch::placementProfileBranch($profile), 'api.placement.show', 'placement_profile', $profile->id);

        return response()->json(app(PlacementProfileQuery::class)->for($profile));
    }

    public function financeLink(string $profileId): JsonResponse
    {
        $profile = PlacementProfile::query()->findOrFail($profileId);
        $this->requireBranchVisible(RecordBranch::placementProfileBranch($profile), 'api.placement.finance_link', 'placement_profile', $profile->id);

        return response()->json(app(PlacementFinanceLinkQuery::class)->for($profile));
    }

    public function eligibilitySnapshot(string $profileId): JsonResponse
    {
        $profile = PlacementProfile::query()->findOrFail($profileId);
        $this->requireBranchVisible(RecordBranch::placementProfileBranch($profile), 'api.placement.eligibility', 'placement_profile', $profile->id);
        $snapshot = app(AcademicEligibilitySnapshotQuery::class)->for($profile);
        if ($snapshot === null) {
            abort(404, 'No signed eligibility snapshot exists for this placement profile.');
        }

        return response()->json(['profile_id' => $profileId] + $snapshot);
    }

    public function openProfile(Request $request): JsonResponse
    {
        $input = $request->validate([
            'person_id' => ['required', 'string'],
            'program_version_id' => ['nullable', 'string'],
            'visitor_id' => ['nullable', 'string'],
            'branch_id' => ['nullable', 'string'],
        ]);

        $result = app(ManagePlacementProfile::class)->openProfile(
            $this->actor(),
            $input['person_id'],
            $input['program_version_id'] ?? null,
            $this->idempotencyKey('placement.profile.open'),
            $input['visitor_id'] ?? null,
            $input['branch_id'] ?? null,
        );

        return response()->json(['status' => 'opened', ...$result], 201);
    }

    public function startAttempt(Request $request): JsonResponse
    {
        $input = $request->validate([
            'profile_id' => ['required', 'string'],
            'test_version_id' => ['required', 'string'],
            'delivery_mode' => ['required', 'in:digital,physical'],
            'proctor_person_id' => ['nullable', 'string'],
        ]);

        $result = app(ManagePlacementProfile::class)->startAttempt(
            $this->actor(),
            PlacementProfile::query()->findOrFail($input['profile_id']),
            $input['test_version_id'],
            $input['delivery_mode'],
            $this->idempotencyKey('placement.attempt.start'),
            $input['proctor_person_id'] ?? null,
        );

        return response()->json(['status' => 'started', ...$result], 201);
    }

    public function submitDigital(Request $request, string $attemptId): JsonResponse
    {
        $input = $request->validate([
            'answers' => ['required', 'array'],
            'answers.*' => ['string'],
        ]);

        $result = app(ManagePlacementProfile::class)->submitDigital(
            $this->actor(),
            PlacementAttempt::query()->findOrFail($attemptId),
            $input['answers'],
            $this->idempotencyKey('placement.attempt.submit'),
        );

        return response()->json(['status' => 'submitted', ...$result]);
    }

    public function submitPhysical(Request $request, string $attemptId): JsonResponse
    {
        $input = $request->validate([
            'evidence_ref' => ['required', 'string', 'max:500'],
        ]);

        $result = app(ManagePlacementProfile::class)->submitPhysical(
            $this->actor(),
            PlacementAttempt::query()->findOrFail($attemptId),
            $input['evidence_ref'],
            $this->idempotencyKey('placement.attempt.submit.physical'),
        );

        return response()->json(['status' => 'submitted', ...$result]);
    }

    public function ingestPhysicalAnswers(Request $request, string $attemptId): JsonResponse
    {
        $input = $request->validate([
            'evidence_ref' => ['required', 'string', 'max:500'],
            'answers' => ['required', 'array'],
            'answers.*' => ['string'],
        ]);

        $result = app(ManagePlacementProfile::class)->ingestPhysicalAnswers(
            $this->actor(),
            PlacementAttempt::query()->findOrFail($attemptId),
            $input['answers'],
            $input['evidence_ref'],
            $this->idempotencyKey('placement.attempt.submit.physical.answers'),
        );

        return response()->json(['status' => 'submitted', ...$result]);
    }

    public function scoreSection(Request $request): JsonResponse
    {
        $input = $request->validate([
            'attempt_id' => ['required', 'string'],
            'section_id' => ['required', 'string'],
            'raw_score' => ['required', 'numeric', 'min:0'],
            'rubric_id' => ['nullable', 'string'],
            'cefr_ref' => ['nullable', 'string'],
            'rationale' => ['nullable', 'string'],
        ]);

        $result = app(ScorePlacement::class)->scoreSection(
            $this->actor(),
            PlacementAttempt::query()->findOrFail($input['attempt_id']),
            $input['section_id'],
            (float) $input['raw_score'],
            $input['rubric_id'] ?? null,
            $input['cefr_ref'] ?? null,
            $input['rationale'] ?? 'Professional marking',
            $this->idempotencyKey('placement.section.score'),
        );

        return response()->json(['status' => 'scored', ...$result]);
    }

    public function moderateSection(Request $request, string $sectionResultId): JsonResponse
    {
        $result = app(ScorePlacement::class)->moderateSection(
            $this->actor(),
            PlacementSectionResult::query()->findOrFail($sectionResultId),
            $this->idempotencyKey('placement.section.moderate'),
        );

        return response()->json(['status' => 'moderated', ...$result]);
    }

    public function approveSection(Request $request, string $sectionResultId): JsonResponse
    {
        $result = app(ScorePlacement::class)->approveSection(
            $this->actor(),
            PlacementSectionResult::query()->findOrFail($sectionResultId),
            $this->idempotencyKey('placement.section.approve'),
        );

        return response()->json(['status' => 'approved', ...$result]);
    }

    public function markScored(string $profileId): JsonResponse
    {
        $result = app(ManagePlacementProfile::class)->markScored(
            $this->actor(),
            PlacementProfile::query()->findOrFail($profileId),
            $this->idempotencyKey('placement.profile.mark-scored'),
        );

        return response()->json(['status' => 'scored', ...$result]);
    }

    public function recommend(string $profileId): JsonResponse
    {
        $result = app(RecommendPlacement::class)->recommend(
            $this->actor(),
            PlacementProfile::query()->findOrFail($profileId),
            $this->idempotencyKey('placement.recommend'),
        );

        return response()->json(['status' => 'recommended', ...$result]);
    }

    public function review(string $profileId): JsonResponse
    {
        $result = app(DecidePlacement::class)->review(
            $this->actor(),
            PlacementProfile::query()->findOrFail($profileId),
            $this->idempotencyKey('placement.review'),
        );

        return response()->json(['status' => 'reviewed', ...$result]);
    }

    public function approve(string $profileId): JsonResponse
    {
        $result = app(DecidePlacement::class)->approve(
            $this->actor(),
            PlacementProfile::query()->findOrFail($profileId),
            $this->idempotencyKey('placement.approve'),
        );

        return response()->json(['status' => 'approved', ...$result]);
    }

    public function release(string $profileId): JsonResponse
    {
        $result = app(DecidePlacement::class)->release(
            $this->actor(),
            PlacementProfile::query()->findOrFail($profileId),
            $this->idempotencyKey('placement.release'),
        );

        return response()->json(['status' => 'released', ...$result]);
    }

    public function supersede(string $profileId): JsonResponse
    {
        $result = app(DecidePlacement::class)->supersede(
            $this->actor(),
            PlacementProfile::query()->findOrFail($profileId),
            $this->idempotencyKey('placement.supersede'),
        );

        return response()->json(['status' => 'superseded', ...$result]);
    }

    public function fileAppeal(Request $request, string $profileId): JsonResponse
    {
        $input = $request->validate([
            'reason' => ['required', 'string', 'max:1000'],
            'student_id' => ['nullable', 'string'],
        ]);

        $result = app(ManageAcademicAppeal::class)->file(
            $this->actor(),
            (string) ($input['student_id'] ?? ''),
            'placement_profile',
            PlacementProfile::query()->findOrFail($profileId)->id,
            $input['reason'],
            $this->idempotencyKey('placement.appeal.file'),
        );

        return response()->json(['status' => 'filed', ...$result], 201);
    }
}
