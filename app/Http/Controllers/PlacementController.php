<?php

declare(strict_types=1);

namespace App\Http\Controllers;

use App\Modules\Academic\Models\Program;
use App\Modules\Academic\Models\ProgramVersion;
use App\Modules\Academic\Models\ProgramVersionLevel;
use App\Modules\Academic\Placement\Commands\DecidePlacement;
use App\Modules\Academic\Placement\Commands\MaintainPlacementCatalog;
use App\Modules\Academic\Placement\Commands\ManagePlacementProfile;
use App\Modules\Academic\Placement\Commands\RecommendPlacement;
use App\Modules\Academic\Placement\Commands\ScorePlacement;
use App\Modules\Academic\Placement\Models\PlacementAttempt;
use App\Modules\Academic\Placement\Models\PlacementProfile;
use App\Modules\Academic\Placement\Models\PlacementQuestion;
use App\Modules\Academic\Placement\Models\PlacementSection;
use App\Modules\Academic\Placement\Models\PlacementSectionResult;
use App\Modules\Academic\Placement\Models\PlacementTest;
use App\Modules\Academic\Placement\Models\PlacementTestVersion;
use App\Modules\Academic\Placement\Queries\PlacementProfileQuery;
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

        return view('placement.index', [
            'profiles' => $query->search(
                (string) $request->query('term', ''),
                (string) $request->query('lifecycle_state', ''),
                (string) $request->query('program_version_id', ''),
            ),
            'tests' => PlacementTest::query()->orderBy('name')->get(),
            'versions' => PlacementTestVersion::query()->orderByDesc('id')->limit(100)->get(),
            'programs' => Program::query()->orderBy('name')->get(),
            'programVersions' => ProgramVersion::query()->orderByDesc('id')->limit(100)->get(),
            'levels' => ProgramVersionLevel::query()->orderBy('ordinal')->limit(200)->get(),
        ]);
    }

    public function show(string $profileId): View
    {
        $profile = PlacementProfile::query()->findOrFail($profileId);
        $data = app(PlacementProfileQuery::class)->for($profile);
        $inProgress = PlacementAttempt::query()
            ->where('profile_id', $profile->id)
            ->where('status', PlacementAttempt::STATUS_IN_PROGRESS)
            ->latest('id')
            ->first();
        $questions = $inProgress !== null
            ? PlacementQuestion::query()
                ->whereIn('section_id', PlacementSection::query()->where('test_version_id', $inProgress->test_version_id)->pluck('id'))
                ->where('lifecycle_state', 'published')
                ->orderBy('code')
                ->get()
            : collect();

        return view('placement.show', $data + [
            'tests' => PlacementTest::query()->orderBy('name')->get(),
            'versions' => PlacementTestVersion::query()->orderByDesc('id')->limit(100)->get(),
            'levels' => ProgramVersionLevel::query()->orderBy('ordinal')->limit(200)->get(),
            'inProgressAttempt' => $inProgress,
            'questions' => $questions,
        ]);
    }

    public function openProfile(Request $request): RedirectResponse
    {
        $input = $request->validate([
            'person_id' => ['required', 'string'],
            'program_version_id' => ['nullable', 'string'],
            'visitor_id' => ['nullable', 'string'],
            'branch_id' => ['nullable', 'string'],
        ]);

        app(ManagePlacementProfile::class)->openProfile(
            $this->actor(),
            $input['person_id'],
            ($input['program_version_id'] ?? null) !== '' ? ($input['program_version_id'] ?? null) : null,
            $this->idempotencyKey('placement.profile.open'),
            ($input['visitor_id'] ?? null) !== '' ? ($input['visitor_id'] ?? null) : null,
            ($input['branch_id'] ?? null) !== '' ? ($input['branch_id'] ?? null) : null,
        );

        return redirect()->route('placement.index')->with('success', 'Placement profile opened.');
    }

    public function startAttempt(Request $request): RedirectResponse
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

        $attempt = PlacementAttempt::query()->findOrFail($attemptId);
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

        $attempt = PlacementAttempt::query()->findOrFail($attemptId);
        app(ManagePlacementProfile::class)->submitPhysical(
            $this->actor(),
            $attempt,
            $input['evidence_ref'],
            $this->idempotencyKey('placement.attempt.submit.physical'),
        );

        return redirect()->route('placement.show', $attempt->profile_id)->with('success', 'Physical placement evidence recorded; awaiting professional marking.');
    }

    public function scoreSection(Request $request): RedirectResponse
    {
        $input = $request->validate([
            'attempt_id' => ['required', 'string'],
            'section_id' => ['required', 'string'],
            'raw_score' => ['required', 'numeric', 'min:0'],
            'rubric_id' => ['nullable', 'string'],
            'cefr_ref' => ['nullable', 'string'],
            'rationale' => ['nullable', 'string'],
        ]);

        $attempt = PlacementAttempt::query()->findOrFail($input['attempt_id']);
        app(ScorePlacement::class)->scoreSection(
            $this->actor(),
            $attempt,
            $input['section_id'],
            (float) $input['raw_score'],
            ($input['rubric_id'] ?? null) !== '' ? ($input['rubric_id'] ?? null) : null,
            ($input['cefr_ref'] ?? null) !== '' ? ($input['cefr_ref'] ?? null) : null,
            (string) ($input['rationale'] ?? 'Professional marking'),
            $this->idempotencyKey('placement.section.score'),
        );

        return redirect()->route('placement.show', $attempt->profile_id)->with('success', 'Section marked.');
    }

    public function moderateSection(Request $request, string $sectionResultId): RedirectResponse
    {
        $result = PlacementSectionResult::query()->findOrFail($sectionResultId);
        app(ScorePlacement::class)->moderateSection($this->actor(), $result, $this->idempotencyKey('placement.section.moderate'));

        return redirect()->route('placement.show', $result->attempt->profile_id)->with('success', 'Section moderated.');
    }

    public function approveSection(Request $request, string $sectionResultId): RedirectResponse
    {
        $result = PlacementSectionResult::query()->findOrFail($sectionResultId);
        app(ScorePlacement::class)->approveSection($this->actor(), $result, $this->idempotencyKey('placement.section.approve'));

        return redirect()->route('placement.show', $result->attempt->profile_id)->with('success', 'Section approved.');
    }

    public function recommend(Request $request, string $profileId): RedirectResponse
    {
        app(RecommendPlacement::class)->recommend($this->actor(), PlacementProfile::query()->findOrFail($profileId), $this->idempotencyKey('placement.recommend'));

        return redirect()->route('placement.show', $profileId)->with('success', 'Recommendation generated.');
    }

    public function review(Request $request, string $profileId): RedirectResponse
    {
        app(DecidePlacement::class)->review($this->actor(), PlacementProfile::query()->findOrFail($profileId), $this->idempotencyKey('placement.review'));

        return redirect()->route('placement.show', $profileId)->with('success', 'Placement reviewed.');
    }

    public function approveProfile(Request $request, string $profileId): RedirectResponse
    {
        app(DecidePlacement::class)->approve($this->actor(), PlacementProfile::query()->findOrFail($profileId), $this->idempotencyKey('placement.approve'));

        return redirect()->route('placement.show', $profileId)->with('success', 'Placement approved.');
    }

    public function releaseProfile(Request $request, string $profileId): RedirectResponse
    {
        app(DecidePlacement::class)->release($this->actor(), PlacementProfile::query()->findOrFail($profileId), $this->idempotencyKey('placement.release'));

        return redirect()->route('placement.show', $profileId)->with('success', 'Placement released.');
    }

    public function supersedeProfile(Request $request, string $profileId): RedirectResponse
    {
        app(DecidePlacement::class)->supersede($this->actor(), PlacementProfile::query()->findOrFail($profileId), $this->idempotencyKey('placement.supersede'));

        return redirect()->route('placement.show', $profileId)->with('success', 'Placement profile superseded; a retake may be opened.');
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
            'branch_id' => ['nullable', 'string'],
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
            ($input['branch_id'] ?? null) !== '' ? ($input['branch_id'] ?? null) : null,
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

        app(MaintainPlacementCatalog::class)->createVersion($this->actor(), PlacementTest::query()->findOrFail($input['test_id']), $input['summary'], $this->idempotencyKey('placement.version.create'));

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
            PlacementTestVersion::query()->findOrFail($input['version_id']),
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
            'media_ref' => ['nullable', 'string', 'max:500'],
        ]);

        app(MaintainPlacementCatalog::class)->defineQuestion(
            $this->actor(),
            PlacementSection::query()->findOrFail($input['section_id']),
            $input['code'],
            $input['stem'],
            $input['question_type'],
            (float) $input['points'],
            null,
            ($input['correct_answer'] ?? null) !== '' ? ($input['correct_answer'] ?? null) : null,
            ($input['media_ref'] ?? null) !== '' ? ($input['media_ref'] ?? null) : null,
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
            PlacementTestVersion::query()->findOrFail($input['version_id']),
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
}
