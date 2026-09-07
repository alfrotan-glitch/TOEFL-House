<?php

declare(strict_types=1);

namespace App\Http\Controllers;

use App\Modules\Academic\Domain\RecordBranch;
use App\Modules\Academic\Models\ProgramVersion;
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
use App\Modules\Academic\Placement\Queries\PlacementAttemptableVersionQuery;
use App\Modules\Academic\Placement\Queries\PlacementFinanceLinkQuery;
use App\Modules\Academic\Placement\Queries\PlacementProfileQuery;
use App\Modules\Documents\Commands\RegisterDocument;
use App\Modules\Organization\Models\Branch;
use App\Support\Authorization\AccessDecision;
use Illuminate\Database\Eloquent\Relations\HasMany;
use Illuminate\Http\RedirectResponse;
use Illuminate\Http\Request;
use Illuminate\View\View;

/**
 * Placement console: test-bank catalog, server-authoritative attempt
 * intake, professional marking, recommendation, and the staged decision
 * chain. Transport-only: all authority/audit/idempotency lives in the
 * placement commands.
 */
final class PlacementController extends Controller
{
    public function index(Request $request): View
    {
        $query = app(PlacementProfileQuery::class);
        $access = app(AccessDecision::class);
        $conductVisible = $this->authorizedBranches('placement.conduct');
        $catalogVisible = $this->authorizedBranches('placement.catalog');
        $canConduct = $access->decide($this->actor(), 'placement.conduct', null)->allowed || $conductVisible !== [];
        $canMaintainCatalog = $access->decide($this->actor(), 'placement.catalog', null)->allowed || $catalogVisible !== [];
        // Placement conduct and catalog maintenance are independent duties.
        // Either grants access to its own projected portion of this console;
        // no branchless/default scope is inferred for a caller with neither.
        if (! $canConduct && ! $canMaintainCatalog) {
            $this->requireOrganizationRead('placement.conduct', 'placement.console.index');
        }
        $conductBranches = Branch::query()->whereIn('id', $conductVisible)->orderBy('name')->get(['id', 'name']);
        $catalogBranches = Branch::query()->whereIn('id', $catalogVisible)->orderBy('name')->get(['id', 'name']);
        $catalogTests = PlacementTest::query()->whereIn('originating_branch_id', $catalogVisible)->orderBy('name')->get();
        $catalogTestIds = $catalogTests->pluck('id')->values()->all();
        $catalogVersions = PlacementTestVersion::query()
            ->whereIn('placement_test_id', $catalogTestIds)
            ->orderByDesc('version_no')
            ->limit(100)
            ->get();
        $catalogSections = PlacementSection::query()
            ->whereIn('test_version_id', $catalogVersions->pluck('id'))
            ->orderBy('test_version_id')
            ->orderBy('section_order')
            ->get();
        $catalogQuestions = PlacementQuestion::query()
            ->whereIn('section_id', $catalogSections->pluck('id'))
            ->with(['media' => static function (HasMany $media): void {
                $media->orderBy('id');
            }])
            ->orderBy('section_id')
            ->orderBy('code')
            ->get();
        $catalogRubrics = PlacementRubric::query()
            ->whereIn('test_version_id', $catalogVersions->pluck('id'))
            ->orderBy('test_version_id')
            ->orderBy('component')
            ->orderBy('min_score')
            ->get();

        return view('placement.index', [
            'profiles' => $query->search(
                (string) $request->query('term', ''),
                (string) $request->query('lifecycle_state', ''),
                (string) $request->query('program_version_id', ''),
                $conductVisible,
            ),
            'canConduct' => $canConduct,
            'conductBranches' => $conductBranches,
            'canMaintainCatalog' => $canMaintainCatalog,
            'catalogBranches' => $catalogBranches,
            'tests' => $catalogTests,
            'versions' => $catalogVersions,
            'sections' => $catalogSections,
            'questions' => $catalogQuestions,
            'rubrics' => $catalogRubrics,
            // Academic definitions are organization-global by their owner
            // contract, and are needed only for catalog test targeting.
            'programVersions' => $canMaintainCatalog
                ? ProgramVersion::query()->orderByDesc('id')->limit(100)->get()
                : collect(),
        ]);
    }

    public function show(string $profileId): View
    {
        $profile = PlacementProfile::query()->findOrFail((string) $profileId);
        $profileBranch = RecordBranch::placementProfileBranch($profile);
        $this->requireBranchCapability('placement.conduct', $profileBranch, 'placement.show', 'placement_profile', $profile->id);
        // Delivery discovery is a conduct-scoped read, not a catalog
        // maintenance privilege. The projection repeats the exact branch and
        // explicit-program compatibility rules used at attempt creation.
        $attemptableVersions = app(PlacementAttemptableVersionQuery::class)->for($profile);
        $financeLink = ($this->branchCapabilityAllowed('finance.obligation', $profileBranch)
            && $this->branchCapabilityAllowed('finance.payment', $profileBranch))
            ? app(PlacementFinanceLinkQuery::class)->for($profile)
            : ['person_id' => $profile->person_id, 'student_id' => null, 'obligations' => [], 'payments' => [], 'eligibility_snapshot' => null];
        $data = app(PlacementProfileQuery::class)->for($profile);
        $inProgress = PlacementAttempt::query()
            ->where('profile_id', $profile->id)
            ->where('status', PlacementAttempt::STATUS_IN_PROGRESS)
            ->orderByDesc('attempt_no')
            ->first();
        /** @var PlacementAttempt|null $scoreableAttempt */
        $scoreableAttempt = PlacementAttempt::query()
            ->where('profile_id', $profile->id)
            ->where('status', PlacementAttempt::STATUS_SUBMITTED)
            ->where('lineage_version', PlacementAttempt::LINEAGE_VERSION)
            ->orderByDesc('attempt_no')
            ->first();
        $questions = $inProgress !== null
            ? PlacementQuestion::query()
                ->whereIn('section_id', PlacementSection::query()->where('test_version_id', $inProgress->test_version_id)->pluck('id'))
                ->where('lifecycle_state', 'published')
                ->with(['media' => static function (HasMany $media): void {
                    $media->where('lifecycle_state', 'active')->orderBy('id');
                }])
                ->orderBy('code')
                ->get()
            : collect();
        // Evidence-only physical delivery is valid only for a fully
        // professionally marked version. A physical version containing any
        // automatic component must transcribe the complete answer sheet so
        // the server, not the proctor, derives its score.
        $physicalAnswerSheetRequired = $inProgress !== null
            && $inProgress->delivery_mode === 'physical'
            && PlacementSection::query()
                ->where('test_version_id', $inProgress->test_version_id)
                ->where('lifecycle_state', 'published')
                ->where('can_auto_score', true)
                ->exists();
        $rubrics = $scoreableAttempt === null
            ? collect()
            : PlacementRubric::query()
                ->where('test_version_id', $scoreableAttempt->test_version_id)
                ->where('lifecycle_state', 'published')
                ->orderBy('component')
                ->orderBy('min_score')
                ->get();

        return view('placement.show', $data + [
            'versions' => $attemptableVersions,
            'inProgressAttempt' => $inProgress,
            'scoreableAttempt' => $scoreableAttempt,
            'questions' => $questions,
            'physicalAnswerSheetRequired' => $physicalAnswerSheetRequired,
            'rubrics' => $rubrics,
            'financeLink' => $financeLink,
        ]);
    }

    public function openProfile(Request $request): RedirectResponse
    {
        $input = $request->validate([
            'person_id' => ['required', 'string'],
            'program_version_id' => ['nullable', 'string'],
            'visitor_id' => ['nullable', 'string'],
            'branch_id' => ['required', 'string'],
        ]);

        app(ManagePlacementProfile::class)->openProfile(
            $this->actor(),
            $input['person_id'],
            ($input['program_version_id'] ?? null) !== '' ? ($input['program_version_id'] ?? null) : null,
            $this->idempotencyKey('placement.profile.open'),
            ($input['visitor_id'] ?? null) !== '' ? ($input['visitor_id'] ?? null) : null,
            $input['branch_id'],
        );

        return redirect()->route('placement.index')->with('success', 'Placement profile opened.');
    }

    public function startAttempt(Request $request): RedirectResponse
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
            ($input['proctor_person_id'] ?? null) !== '' ? ($input['proctor_person_id'] ?? null) : null,
        );

        return redirect()->route('placement.show', $input['profile_id'])->with('success', 'Placement attempt started.')->with('attempt_id', $result['attempt_id']);
    }

    public function submitDigital(Request $request, string $attemptId): RedirectResponse
    {
        $input = $request->validate([
            'answers' => ['required', 'array'],
            'answers.*' => ['string'],
        ]);

        $attempt = PlacementAttempt::query()->findOrFail((string) $attemptId);
        $result = app(ManagePlacementProfile::class)->submitDigital(
            $this->actor(),
            $attempt,
            $input['answers'],
            $this->idempotencyKey('placement.attempt.submit'),
        );

        return redirect()->route('placement.show', $attempt->profile_id)->with(
            'success',
            $result['tamper_flagged'] ? 'Placement submitted; the attempt was flagged for the duration envelope.' : 'Placement submitted and auto-scored.',
        );
    }

    public function submitPhysical(Request $request, string $attemptId): RedirectResponse
    {
        $input = $request->validate([
            'evidence_ref' => ['required', 'string', 'max:500'],
        ]);

        $attempt = PlacementAttempt::query()->findOrFail((string) $attemptId);
        $result = app(ManagePlacementProfile::class)->submitPhysical(
            $this->actor(),
            $attempt,
            $input['evidence_ref'],
            $this->idempotencyKey('placement.attempt.submit.physical'),
        );

        return redirect()->route('placement.show', $attempt->profile_id)->with(
            'success',
            $result['tamper_flagged']
                ? 'Physical placement evidence was submitted and flagged for the duration envelope.'
                : 'Physical placement evidence recorded; awaiting professional marking.',
        );
    }

    /**
     * Transcribes a proctored physical answer sheet as immutable normalized
     * evidence. This is intentionally separate from evidence-only physical
     * submission: the latter is forbidden for versions with auto-scored
     * sections, because a proctor must never supply an outcome in place of
     * server-derived scoring.
     */
    public function ingestPhysicalAnswers(Request $request, string $attemptId): RedirectResponse
    {
        $input = $request->validate([
            'evidence_ref' => ['required', 'string', 'max:500'],
            'answers' => ['required', 'array'],
            'answers.*' => ['string'],
        ]);

        $attempt = PlacementAttempt::query()->findOrFail((string) $attemptId);
        $result = app(ManagePlacementProfile::class)->ingestPhysicalAnswers(
            $this->actor(),
            $attempt,
            $input['answers'],
            $input['evidence_ref'],
            $this->idempotencyKey('placement.attempt.submit.physical.answers'),
        );

        return redirect()->route('placement.show', $attempt->profile_id)->with(
            'success',
            $result['tamper_flagged']
                ? 'Physical answer-sheet evidence was submitted and flagged for the duration envelope.'
                : 'Physical answer sheet recorded and automatic sections server-scored.',
        );
    }

    public function scoreSection(Request $request): RedirectResponse
    {
        $input = $request->validate([
            'attempt_id' => ['required', 'string'],
            'section_id' => ['required', 'string'],
            'raw_score' => ['required', 'numeric', 'min:0', 'max:100'],
            'rubric_id' => ['required', 'string'],
            'cefr_ref' => ['prohibited'],
            'rationale' => ['nullable', 'string'],
        ]);

        $attempt = PlacementAttempt::query()->findOrFail((string) $input['attempt_id']);
        app(ScorePlacement::class)->scoreSection(
            $this->actor(),
            $attempt,
            $input['section_id'],
            (float) $input['raw_score'],
            $input['rubric_id'],
            null,
            (string) ($input['rationale'] ?? 'Professional marking'),
            $this->idempotencyKey('placement.section.score'),
        );

        return redirect()->route('placement.show', $attempt->profile_id)->with('success', 'Section marked.');
    }

    public function moderateSection(Request $request, string $sectionResultId): RedirectResponse
    {
        $result = PlacementSectionResult::query()->findOrFail((string) $sectionResultId);
        app(ScorePlacement::class)->moderateSection($this->actor(), $result, $this->idempotencyKey('placement.section.moderate'));
        $attempt = PlacementAttempt::query()->findOrFail((string) $result->attempt_id);

        return redirect()->route('placement.show', $attempt->profile_id)->with('success', 'Section moderated.');
    }

    public function approveSection(Request $request, string $sectionResultId): RedirectResponse
    {
        $result = PlacementSectionResult::query()->findOrFail((string) $sectionResultId);
        app(ScorePlacement::class)->approveSection($this->actor(), $result, $this->idempotencyKey('placement.section.approve'));
        $attempt = PlacementAttempt::query()->findOrFail((string) $result->attempt_id);

        return redirect()->route('placement.show', $attempt->profile_id)->with('success', 'Section approved.');
    }

    public function markScored(Request $request, string $profileId): RedirectResponse
    {
        app(ManagePlacementProfile::class)->markScored($this->actor(), PlacementProfile::query()->findOrFail((string) $profileId), $this->idempotencyKey('placement.profile.mark-scored'));

        return redirect()->route('placement.show', $profileId)->with('success', 'Placement marked scored.');
    }

    public function recommend(Request $request, string $profileId): RedirectResponse
    {
        app(RecommendPlacement::class)->recommend($this->actor(), PlacementProfile::query()->findOrFail((string) $profileId), $this->idempotencyKey('placement.recommend'));

        return redirect()->route('placement.show', $profileId)->with('success', 'Recommendation generated.');
    }

    public function review(Request $request, string $profileId): RedirectResponse
    {
        app(DecidePlacement::class)->review($this->actor(), PlacementProfile::query()->findOrFail((string) $profileId), $this->idempotencyKey('placement.review'));

        return redirect()->route('placement.show', $profileId)->with('success', 'Placement reviewed.');
    }

    public function approveProfile(Request $request, string $profileId): RedirectResponse
    {
        app(DecidePlacement::class)->approve($this->actor(), PlacementProfile::query()->findOrFail((string) $profileId), $this->idempotencyKey('placement.approve'));

        return redirect()->route('placement.show', $profileId)->with('success', 'Placement approved.');
    }

    public function releaseProfile(Request $request, string $profileId): RedirectResponse
    {
        app(DecidePlacement::class)->release($this->actor(), PlacementProfile::query()->findOrFail((string) $profileId), $this->idempotencyKey('placement.release'));

        return redirect()->route('placement.show', $profileId)->with('success', 'Placement released.');
    }

    public function supersedeProfile(Request $request, string $profileId): RedirectResponse
    {
        app(DecidePlacement::class)->supersede($this->actor(), PlacementProfile::query()->findOrFail((string) $profileId), $this->idempotencyKey('placement.supersede'));

        return redirect()->route('placement.show', $profileId)->with('success', 'Placement profile superseded; a retake may be opened.');
    }

    public function registerReport(Request $request, string $profileId): RedirectResponse
    {
        $input = $request->validate([
            'classification_id' => ['required', 'string'],
            'title' => ['required', 'string', 'max:200'],
            'content_hash' => ['required', 'string', 'size:64'],
            'storage_ref' => ['required', 'string', 'max:500'],
        ]);

        $profile = PlacementProfile::query()->findOrFail((string) $profileId);
        $this->requireBranchCapability('placement.conduct', RecordBranch::placementProfileBranch($profile), 'placement.report.register', 'placement_profile', $profile->id);
        app(RegisterDocument::class)->register(
            $this->actor(),
            $profile->person_id,
            $input['classification_id'],
            $input['title'],
            $input['content_hash'],
            $input['storage_ref'],
            $this->idempotencyKey('placement.document.register'),
        );

        return redirect()->route('placement.show', $profileId)->with('success', 'Placement report registered as a Documents version.');
    }

    public function defineTest(Request $request): RedirectResponse
    {
        $input = $request->validate([
            'key' => ['required', 'string', 'max:60'],
            'name' => ['required', 'string', 'max:160'],
            'program_version_id' => ['nullable', 'string'],
            'total_time_minutes' => ['required', 'integer', 'min:1'],
            'grammar_weight' => ['required', 'numeric', 'min:0.1'],
            'reading_weight' => ['required', 'numeric', 'min:0.1'],
            'listening_weight' => ['required', 'numeric', 'min:0.1'],
            'writing_weight' => ['required', 'numeric', 'min:0.1'],
            'speaking_weight' => ['required', 'numeric', 'min:0.1'],
            'branch_id' => ['required', 'string'],
        ]);

        $weights = [
            'grammar' => (float) $input['grammar_weight'],
            'reading' => (float) $input['reading_weight'],
            'listening' => (float) $input['listening_weight'],
            'writing' => (float) $input['writing_weight'],
            'speaking' => (float) $input['speaking_weight'],
        ];

        app(MaintainPlacementCatalog::class)->defineTest(
            $this->actor(),
            $input['key'],
            $input['name'],
            ($input['program_version_id'] ?? null) !== '' ? ($input['program_version_id'] ?? null) : null,
            (int) $input['total_time_minutes'],
            $weights,
            $this->idempotencyKey('placement.test.define'),
            $input['branch_id'],
        );

        return redirect()->route('placement.index')->with('success', 'Placement test defined.');
    }

    public function publishTest(Request $request, string $testId): RedirectResponse
    {
        app(MaintainPlacementCatalog::class)->transitionTest($this->actor(), PlacementTest::query()->findOrFail($testId), 'published', $this->idempotencyKey('placement.test.publish'));

        return redirect()->route('placement.index')->with('success', 'Placement test published.');
    }

    public function createVersion(Request $request): RedirectResponse
    {
        $input = $request->validate([
            'test_id' => ['required', 'string'],
            'summary' => ['required', 'string', 'max:1000'],
        ]);

        app(MaintainPlacementCatalog::class)->createVersion($this->actor(), PlacementTest::query()->findOrFail((string) $input['test_id']), $input['summary'], $this->idempotencyKey('placement.version.create'));

        return redirect()->route('placement.index')->with('success', 'Placement version draft created.');
    }

    public function publishVersion(Request $request, string $versionId): RedirectResponse
    {
        app(MaintainPlacementCatalog::class)->publishVersion($this->actor(), PlacementTestVersion::query()->findOrFail($versionId), $this->idempotencyKey('placement.version.publish'));

        return redirect()->route('placement.index')->with('success', 'Placement version published (immutable).');
    }

    public function defineSection(Request $request): RedirectResponse
    {
        $input = $request->validate([
            'version_id' => ['required', 'string'],
            'code' => ['required', 'string', 'max:40'],
            'name' => ['required', 'string', 'max:160'],
            'component' => ['required', 'in:grammar,reading,listening,writing,speaking'],
            'section_order' => ['required', 'integer', 'min:0'],
            'time_minutes' => ['required', 'integer', 'min:1'],
            'delivery_mode' => ['required', 'in:digital,physical'],
            'can_auto_score' => ['nullable', 'boolean'],
        ]);

        app(MaintainPlacementCatalog::class)->defineSection(
            $this->actor(),
            PlacementTestVersion::query()->findOrFail((string) $input['version_id']),
            $input['code'],
            $input['name'],
            $input['component'],
            (int) $input['section_order'],
            (int) $input['time_minutes'],
            $input['delivery_mode'],
            (bool) ($input['can_auto_score'] ?? false),
            $this->idempotencyKey('placement.section.define'),
        );

        return redirect()->route('placement.index')->with('success', 'Placement section defined.');
    }

    public function defineQuestion(Request $request): RedirectResponse
    {
        $input = $request->validate([
            'section_id' => ['required', 'string'],
            'code' => ['required', 'string', 'max:40'],
            'stem' => ['required', 'string', 'max:2000'],
            'question_type' => ['required', 'in:mcq,short_answer,essay,speaking'],
            'points' => ['required', 'numeric', 'min:0.01'],
            'correct_answer' => ['nullable', 'string', 'max:500'],
            // A direct media pointer bypasses the immutable checksummed
            // attachment authority; use the dedicated media endpoint.
            'media_ref' => ['missing'],
        ]);

        app(MaintainPlacementCatalog::class)->defineQuestion(
            $this->actor(),
            PlacementSection::query()->findOrFail((string) $input['section_id']),
            $input['code'],
            $input['stem'],
            $input['question_type'],
            (float) $input['points'],
            null,
            ($input['correct_answer'] ?? null) !== '' ? ($input['correct_answer'] ?? null) : null,
            $this->idempotencyKey('placement.question.define'),
        );

        return redirect()->route('placement.index')->with('success', 'Placement question defined.');
    }

    public function defineRubric(Request $request): RedirectResponse
    {
        $input = $request->validate([
            'version_id' => ['required', 'string'],
            'component' => ['required', 'in:grammar,reading,listening,writing,speaking'],
            'band' => ['required', 'string', 'max:40'],
            'min_score' => ['required', 'numeric', 'min:0', 'max:100'],
            'max_score' => ['required', 'numeric', 'min:0', 'max:100', 'gte:min_score'],
            'cefr_ref' => ['required', 'string', 'max:10'],
            'description' => ['required', 'string', 'max:2000'],
        ]);

        app(MaintainPlacementCatalog::class)->defineRubric(
            $this->actor(),
            PlacementTestVersion::query()->findOrFail((string) $input['version_id']),
            $input['component'],
            $input['band'],
            (float) $input['min_score'],
            (float) $input['max_score'],
            $input['cefr_ref'],
            $input['description'],
            $this->idempotencyKey('placement.rubric.define'),
        );

        return redirect()->route('placement.index')->with('success', 'Placement rubric defined.');
    }

    public function transitionSection(Request $request, string $sectionId): RedirectResponse
    {
        $input = $request->validate(['to_state' => ['required', 'in:published,retired']]);
        app(MaintainPlacementCatalog::class)->transitionSection($this->actor(), PlacementSection::query()->findOrFail($sectionId), $input['to_state'], $this->idempotencyKey('placement.section.transition'));

        return redirect()->route('placement.index')->with('success', 'Placement section transitioned.');
    }

    public function transitionQuestion(Request $request, string $questionId): RedirectResponse
    {
        $input = $request->validate(['to_state' => ['required', 'in:published,retired']]);
        app(MaintainPlacementCatalog::class)->transitionQuestion($this->actor(), PlacementQuestion::query()->findOrFail($questionId), $input['to_state'], $this->idempotencyKey('placement.question.transition'));

        return redirect()->route('placement.index')->with('success', 'Placement question transitioned.');
    }

    public function attachQuestionMedia(Request $request, string $questionId): RedirectResponse
    {
        $input = $request->validate([
            'uri' => ['required', 'string', 'max:500'],
            'media_type' => ['required', 'string', 'max:60'],
            'sha256' => ['required', 'string', 'regex:/^[0-9a-f]{64}$/'],
            'mime_type' => ['required', 'string', 'max:120'],
        ]);
        app(MaintainPlacementCatalog::class)->attachMedia(
            $this->actor(),
            PlacementQuestion::query()->findOrFail($questionId),
            $input['uri'],
            $input['media_type'],
            $input['sha256'],
            $input['mime_type'],
            $this->idempotencyKey('placement.question.media.attach'),
        );

        return redirect()->route('placement.index')->with('success', 'Placement question media attached.');
    }

    public function transitionRubric(Request $request, string $rubricId): RedirectResponse
    {
        $input = $request->validate(['to_state' => ['required', 'in:published,retired']]);
        app(MaintainPlacementCatalog::class)->transitionRubric($this->actor(), PlacementRubric::query()->findOrFail($rubricId), $input['to_state'], $this->idempotencyKey('placement.rubric.transition'));

        return redirect()->route('placement.index')->with('success', 'Placement rubric transitioned.');
    }
}
