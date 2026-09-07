<?php

declare(strict_types=1);

namespace App\Http\Controllers\Api;

use App\Http\Controllers\Controller;
use App\Modules\Academic\Commands\ManageAcademicAppeal;
use App\Modules\Academic\Domain\RecordBranch;
use App\Modules\Academic\Placement\Commands\DecidePlacement;
use App\Modules\Academic\Placement\Commands\MaintainPlacementCatalog;
use App\Modules\Academic\Placement\Commands\ManagePlacementProfile;
use App\Modules\Academic\Placement\Commands\RecommendPlacement;
use App\Modules\Academic\Placement\Commands\ScorePlacement;
use App\Modules\Academic\Placement\Models\PlacementAttempt;
use App\Modules\Academic\Placement\Models\PlacementProfile;
use App\Modules\Academic\Placement\Models\PlacementQuestion;
use App\Modules\Academic\Placement\Models\PlacementRubric;
use App\Modules\Academic\Placement\Models\PlacementSection;
use App\Modules\Academic\Placement\Models\PlacementSectionResult;
use App\Modules\Academic\Placement\Models\PlacementTest;
use App\Modules\Academic\Placement\Models\PlacementTestVersion;
use App\Modules\Documents\Commands\RegisterDocument;
use App\Modules\Academic\Placement\Queries\AcademicEligibilitySnapshotQuery;
use App\Modules\Academic\Placement\Queries\PlacementAttemptableVersionQuery;
use App\Modules\Academic\Placement\Queries\PlacementFinanceLinkQuery;
use App\Modules\Academic\Placement\Queries\PlacementProfileQuery;
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
        $visible = $this->authorizedBranches('placement.catalog');
        if ($visible !== []) {
            $tests = PlacementTest::query()
                ->whereIn('originating_branch_id', $visible)
                ->orderBy('name')->get([
                    'id', 'key', 'name', 'program_version_id', 'total_time_minutes',
                    'component_weights', 'lifecycle_state', 'originating_branch_id',
                ]);
        }

        return response()->json(['tests' => $tests]);
    }

    public function versions(): JsonResponse
    {
        $versions = [];
        $visible = $this->authorizedBranches('placement.catalog');
        if ($visible !== []) {
            $versions = PlacementTestVersion::query()
                ->whereIn('placement_test_id', PlacementTest::query()->whereIn('originating_branch_id', $visible)->select('id'))
                ->orderByDesc('id')->limit(200)->get([
                    'id', 'placement_test_id', 'version_no', 'summary', 'lifecycle_state', 'published_at',
                ]);
        }

        return response()->json(['versions' => $versions]);
    }

    public function attemptableVersions(string $profileId): JsonResponse
    {
        $profile = PlacementProfile::query()->findOrFail($profileId);
        $this->requireBranchCapability('placement.conduct', RecordBranch::placementProfileBranch($profile), 'api.placement.attemptable_versions', 'placement_profile', $profile->id);

        return response()->json([
            'profile_id' => $profile->id,
            'versions' => app(PlacementAttemptableVersionQuery::class)->for($profile),
        ]);
    }

    public function profiles(Request $request): JsonResponse
    {
        $profiles = [];
        $visible = $this->authorizedBranches('placement.conduct');
        if ($visible !== []) {
            $profiles = app(PlacementProfileQuery::class)->search(
                (string) $request->query('term', ''),
                (string) $request->query('lifecycle_state', ''),
                (string) $request->query('program_version_id', ''),
                $visible,
            );
        }

        return response()->json(['profiles' => $profiles]);
    }

    public function show(string $profileId): JsonResponse
    {
        $profile = PlacementProfile::query()->findOrFail($profileId);
        $this->requireBranchCapability('placement.conduct', RecordBranch::placementProfileBranch($profile), 'api.placement.show', 'placement_profile', $profile->id);

        return response()->json(app(PlacementProfileQuery::class)->for($profile));
    }

    public function financeLink(string $profileId): JsonResponse
    {
        $profile = PlacementProfile::query()->findOrFail($profileId);
        $branchId = RecordBranch::placementProfileBranch($profile);
        $this->requireBranchCapability('placement.conduct', $branchId, 'api.placement.finance_link', 'placement_profile', $profile->id);
        $this->requireBranchCapability('finance.obligation', $branchId, 'api.placement.finance_link', 'placement_profile', $profile->id);
        $this->requireBranchCapability('finance.payment', $branchId, 'api.placement.finance_link', 'placement_profile', $profile->id);

        return response()->json(app(PlacementFinanceLinkQuery::class)->for($profile));
    }

    public function eligibilitySnapshot(string $profileId): JsonResponse
    {
        $profile = PlacementProfile::query()->findOrFail($profileId);
        $this->requireBranchCapability('placement.conduct', RecordBranch::placementProfileBranch($profile), 'api.placement.eligibility', 'placement_profile', $profile->id);
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
            'branch_id' => ['required', 'string'],
        ]);

        $result = app(ManagePlacementProfile::class)->openProfile(
            $this->actor(),
            $input['person_id'],
            $this->optional($input['program_version_id'] ?? null),
            $this->idempotencyKey('placement.profile.open'),
            $this->optional($input['visitor_id'] ?? null),
            $input['branch_id'],
        );

        return response()->json(['status' => 'opened', ...$result], 201);
    }

    public function startAttempt(Request $request): JsonResponse
    {
        $input = $request->validate([
            'profile_id' => ['required', 'string'],
            'test_version_id' => ['required', 'string'],
            'delivery_mode' => ['required', 'in:digital,physical'],
            'proctor_person_id' => ['nullable', 'string', 'required_if:delivery_mode,physical'],
        ]);

        $result = app(ManagePlacementProfile::class)->startAttempt(
            $this->actor(),
            PlacementProfile::query()->findOrFail((string) $input['profile_id']),
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
            'raw_score' => ['required', 'numeric', 'min:0', 'max:100'],
            'rubric_id' => ['required', 'string'],
            'cefr_ref' => ['prohibited'],
            'rationale' => ['nullable', 'string'],
        ]);

        $result = app(ScorePlacement::class)->scoreSection(
            $this->actor(),
            PlacementAttempt::query()->findOrFail((string) $input['attempt_id']),
            $input['section_id'],
            (float) $input['raw_score'],
            $input['rubric_id'],
            null,
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

    public function registerReport(Request $request, string $profileId): JsonResponse
    {
        $input = $request->validate([
            'classification_id' => ['required', 'string'], 'title' => ['required', 'string', 'max:200'],
            'content_hash' => ['required', 'string', 'size:64'], 'storage_ref' => ['required', 'string', 'max:500'],
        ]);
        $profile = PlacementProfile::query()->findOrFail($profileId);
        $this->requireBranchCapability('placement.conduct', RecordBranch::placementProfileBranch($profile), 'api.placement.report', 'placement_profile', $profile->id);
        $result = app(RegisterDocument::class)->register(
            $this->actor(), $profile->person_id, $input['classification_id'], $input['title'], $input['content_hash'],
            $input['storage_ref'], $this->idempotencyKey('placement.document.register'),
        );

        return response()->json(['status' => 'registered', ...$result], 201);
    }

    public function defineTest(Request $request): JsonResponse
    {
        $input = $request->validate([
            'key' => ['required', 'string', 'max:60'], 'name' => ['required', 'string', 'max:160'],
            'program_version_id' => ['nullable', 'string'], 'total_time_minutes' => ['required', 'integer', 'min:1'],
            'grammar_weight' => ['required', 'numeric', 'min:0.1'], 'reading_weight' => ['required', 'numeric', 'min:0.1'],
            'listening_weight' => ['required', 'numeric', 'min:0.1'], 'writing_weight' => ['required', 'numeric', 'min:0.1'],
            'speaking_weight' => ['required', 'numeric', 'min:0.1'], 'branch_id' => ['required', 'string'],
        ]);
        $weights = [
            'grammar' => (float) $input['grammar_weight'], 'reading' => (float) $input['reading_weight'],
            'listening' => (float) $input['listening_weight'], 'writing' => (float) $input['writing_weight'],
            'speaking' => (float) $input['speaking_weight'],
        ];
        $result = app(MaintainPlacementCatalog::class)->defineTest(
            $this->actor(), $input['key'], $input['name'], $this->optional($input['program_version_id'] ?? null),
            (int) $input['total_time_minutes'], $weights, $this->idempotencyKey('placement.test.define'), $input['branch_id'],
        );

        return response()->json(['status' => 'defined', ...$result], 201);
    }

    public function transitionTest(Request $request, string $testId): JsonResponse
    {
        $input = $request->validate(['to_state' => ['required', 'in:published,retired']]);
        $result = app(MaintainPlacementCatalog::class)->transitionTest($this->actor(), PlacementTest::query()->findOrFail($testId), $input['to_state'], $this->idempotencyKey('placement.test.transition'));

        return response()->json(['status' => 'transitioned', ...$result]);
    }

    public function createVersion(Request $request): JsonResponse
    {
        $input = $request->validate(['test_id' => ['required', 'string'], 'summary' => ['required', 'string', 'max:1000']]);
        $result = app(MaintainPlacementCatalog::class)->createVersion($this->actor(), PlacementTest::query()->findOrFail((string) $input['test_id']), $input['summary'], $this->idempotencyKey('placement.version.create'));

        return response()->json(['status' => 'created', ...$result], 201);
    }

    public function transitionVersion(Request $request, string $versionId): JsonResponse
    {
        $input = $request->validate(['to_state' => ['required', 'in:published,retired']]);
        $result = app(MaintainPlacementCatalog::class)->transitionVersion($this->actor(), PlacementTestVersion::query()->findOrFail($versionId), $input['to_state'], $this->idempotencyKey('placement.version.transition'));

        return response()->json(['status' => 'transitioned', ...$result]);
    }

    public function publishVersion(Request $request, string $versionId): JsonResponse
    {
        $result = app(MaintainPlacementCatalog::class)->publishVersion($this->actor(), PlacementTestVersion::query()->findOrFail($versionId), $this->idempotencyKey('placement.version.publish'));

        return response()->json(['status' => 'published', ...$result]);
    }

    public function defineSection(Request $request): JsonResponse
    {
        $input = $request->validate([
            'version_id' => ['required', 'string'], 'code' => ['required', 'string', 'max:40'], 'name' => ['required', 'string', 'max:160'],
            'component' => ['required', 'in:grammar,reading,listening,writing,speaking'], 'section_order' => ['required', 'integer', 'min:0'],
            'time_minutes' => ['required', 'integer', 'min:1'], 'delivery_mode' => ['required', 'in:digital,physical'], 'can_auto_score' => ['nullable', 'boolean'],
        ]);
        $result = app(MaintainPlacementCatalog::class)->defineSection(
            $this->actor(), PlacementTestVersion::query()->findOrFail((string) $input['version_id']), $input['code'], $input['name'], $input['component'],
            (int) $input['section_order'], (int) $input['time_minutes'], $input['delivery_mode'], (bool) ($input['can_auto_score'] ?? false),
            $this->idempotencyKey('placement.section.define'),
        );

        return response()->json(['status' => 'defined', ...$result], 201);
    }

    public function transitionSection(Request $request, string $sectionId): JsonResponse
    {
        $input = $request->validate(['to_state' => ['required', 'in:published,retired']]);
        $result = app(MaintainPlacementCatalog::class)->transitionSection($this->actor(), PlacementSection::query()->findOrFail($sectionId), $input['to_state'], $this->idempotencyKey('placement.section.transition'));

        return response()->json(['status' => 'transitioned', ...$result]);
    }

    public function defineQuestion(Request $request): JsonResponse
    {
        $input = $request->validate([
            'section_id' => ['required', 'string'], 'code' => ['required', 'string', 'max:40'], 'stem' => ['required', 'string', 'max:2000'],
            'question_type' => ['required', 'in:mcq,short_answer,essay,speaking'], 'points' => ['required', 'numeric', 'min:0.01'],
            'options' => ['nullable', 'array'], 'correct_answer' => ['nullable', 'string', 'max:500'],
            // Question media is accepted only through the checksummed media
            // attachment authority.
            'media_ref' => ['missing'],
        ]);
        $result = app(MaintainPlacementCatalog::class)->defineQuestion(
            $this->actor(), PlacementSection::query()->findOrFail((string) $input['section_id']), $input['code'], $input['stem'], $input['question_type'],
            (float) $input['points'], $input['options'] ?? null, $this->optional($input['correct_answer'] ?? null),
            $this->idempotencyKey('placement.question.define'),
        );

        return response()->json(['status' => 'defined', ...$result], 201);
    }

    public function transitionQuestion(Request $request, string $questionId): JsonResponse
    {
        $input = $request->validate(['to_state' => ['required', 'in:published,retired']]);
        $result = app(MaintainPlacementCatalog::class)->transitionQuestion($this->actor(), PlacementQuestion::query()->findOrFail($questionId), $input['to_state'], $this->idempotencyKey('placement.question.transition'));

        return response()->json(['status' => 'transitioned', ...$result]);
    }

    public function attachMedia(Request $request, string $questionId): JsonResponse
    {
        $input = $request->validate([
            'uri' => ['required', 'string', 'max:500'], 'media_type' => ['required', 'string', 'max:60'],
            'sha256' => ['required', 'string', 'regex:/^[0-9a-f]{64}$/'], 'mime_type' => ['required', 'string', 'max:120'],
        ]);
        $result = app(MaintainPlacementCatalog::class)->attachMedia(
            $this->actor(), PlacementQuestion::query()->findOrFail($questionId), $input['uri'], $input['media_type'], $input['sha256'], $input['mime_type'],
            $this->idempotencyKey('placement.question.media.attach'),
        );

        return response()->json(['status' => 'attached', ...$result], 201);
    }

    public function defineRubric(Request $request): JsonResponse
    {
        $input = $request->validate([
            'version_id' => ['required', 'string'], 'component' => ['required', 'in:grammar,reading,listening,writing,speaking'],
            'band' => ['required', 'string', 'max:40'], 'min_score' => ['required', 'numeric', 'min:0', 'max:100'],
            'max_score' => ['required', 'numeric', 'min:0', 'max:100', 'gte:min_score'], 'cefr_ref' => ['required', 'string', 'max:10'],
            'description' => ['required', 'string', 'max:2000'],
        ]);
        $result = app(MaintainPlacementCatalog::class)->defineRubric(
            $this->actor(), PlacementTestVersion::query()->findOrFail((string) $input['version_id']), $input['component'], $input['band'],
            (float) $input['min_score'], (float) $input['max_score'], $input['cefr_ref'], $input['description'], $this->idempotencyKey('placement.rubric.define'),
        );

        return response()->json(['status' => 'defined', ...$result], 201);
    }

    public function transitionRubric(Request $request, string $rubricId): JsonResponse
    {
        $input = $request->validate(['to_state' => ['required', 'in:published,retired']]);
        $result = app(MaintainPlacementCatalog::class)->transitionRubric($this->actor(), PlacementRubric::query()->findOrFail($rubricId), $input['to_state'], $this->idempotencyKey('placement.rubric.transition'));

        return response()->json(['status' => 'transitioned', ...$result]);
    }

    public function cancelAttempt(Request $request, string $attemptId): JsonResponse
    {
        $result = app(ManagePlacementProfile::class)->cancelAttempt($this->actor(), PlacementAttempt::query()->findOrFail($attemptId), $this->idempotencyKey('placement.attempt.cancel'));

        return response()->json(['status' => 'cancelled', ...$result]);
    }

    private function optional(?string $value): ?string
    {
        return $value !== null && $value !== '' ? $value : null;
    }

    public function fileAppeal(Request $request, string $profileId): JsonResponse
    {
        $input = $request->validate([
            'reason' => ['required', 'string', 'max:1000'],
        ]);

        $result = app(ManageAcademicAppeal::class)->file(
            $this->actor(),
            '',
            'placement_profile',
            PlacementProfile::query()->findOrFail($profileId)->id,
            $input['reason'],
            $this->idempotencyKey('placement.appeal.file'),
        );

        return response()->json(['status' => 'filed', ...$result], 201);
    }
}
