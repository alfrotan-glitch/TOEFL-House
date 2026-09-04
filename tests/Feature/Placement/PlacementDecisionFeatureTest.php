<?php

declare(strict_types=1);

namespace Tests\Feature\Placement;

use App\Modules\Academic\Commands\MaintainAcademicStructure;
use App\Modules\Academic\Models\Program;
use App\Modules\Academic\Placement\Commands\DecidePlacement;
use App\Modules\Academic\Placement\Commands\MaintainPlacementCatalog;
use App\Modules\Academic\Placement\Commands\ManagePlacementProfile;
use App\Modules\Academic\Placement\Commands\RecommendPlacement;
use App\Modules\Academic\Placement\Commands\ScorePlacement;
use App\Modules\Academic\Placement\Models\PlacementAttempt;
use App\Modules\Academic\Placement\Models\PlacementProfile;
use App\Modules\Academic\Placement\Models\PlacementQuestion;
use App\Modules\Academic\Placement\Models\PlacementRecommendation;
use App\Modules\Academic\Placement\Models\PlacementResponse;
use App\Modules\Academic\Placement\Models\PlacementRubric;
use App\Modules\Academic\Placement\Models\PlacementSection;
use App\Modules\Academic\Placement\Models\PlacementSectionResult;
use App\Modules\Academic\Placement\Models\PlacementTest;
use App\Modules\Academic\Placement\Models\PlacementTestVersion;
use App\Modules\Crm\Commands\CaptureVisitor;
use App\Modules\Crm\Commands\LinkVisitorPerson;
use App\Modules\Crm\Models\Visitor;
use App\Support\Errors\BusinessRejection;
use Illuminate\Database\QueryException;
use Tests\Concerns\BuildsActors;
use Tests\TestCase;

/**
 * Full Placement Decision System journey: catalog -> published version ->
 * server-authoritative digital attempt -> anti-tamper evidence -> marking ->
 * staged section moderation/approval -> explainable CEFR/level recommendation
 * -> review/approve/release -> retake after supersession -> appealable
 * profile, with immutable responses and CRM lead tracing.
 */
final class PlacementDecisionFeatureTest extends TestCase
{
    use BuildsActors;

    private int $actorSequence = 0;

    private string $programVersionId;

    private string $testVersionId;

    /** @var array<string, string> */
    private array $questions = [];

    /** @var array<string, array{section: string, comment: string}> */
    private array $manualSectionResults = [];

    /** @var array<string, string> */
    private array $sectionIds = [];

    private function setUpPlacementCatalog(): void
    {
        $officer = $this->placementOfficer('plc-setup-1');
        $academic = $this->academicOfficer('plc-acad-1');

        $program = app(MaintainAcademicStructure::class)->defineProgram($academic, 'IELTS Preparation', 'plc-prog');
        $version = app(MaintainAcademicStructure::class)->publishVersion($academic, Program::query()->findOrFail($program['program_id']), 'placement target', 'plc-ver');
        $this->programVersionId = $version['version_id'];

        foreach ([['A1', 1, 'A1'], ['A2', 2, 'A2'], ['B1', 3, 'B1'], ['B2', 4, 'B2'], ['C1', 5, 'C1']] as [$key, $ordinal, $cefr]) {
            app(MaintainAcademicStructure::class)->defineLevel($academic, $this->programVersionId, $key, $ordinal, $key.' level', $cefr, 'plc-level-'.$key);
        }

        $catalog = app(MaintainPlacementCatalog::class);
        $test = $catalog->defineTest(
            $this->placementOfficer('plc-cat-1'),
            'placement-standard',
            'Standard Placement',
            $this->programVersionId,
            90,
            ['grammar' => 20, 'reading' => 20, 'listening' => 20, 'writing' => 20, 'speaking' => 20],
            'plc-test-1',
        );
        $catalog->transitionTest($this->placementOfficer('plc-cat-2'), PlacementTest::query()->findOrFail($test['test_id']), 'published', 'plc-test-pub');
        $version = $catalog->createVersion($this->placementOfficer('plc-cat-3'), PlacementTest::query()->findOrFail($test['test_id']), 'standard v1', 'plc-ver-draft');
        $this->testVersionId = $version['version_id'];

        // Auto-scored sections.
        foreach (['grammar', 'reading', 'listening'] as $component) {
            $section = $catalog->defineSection($this->placementOfficer('plc-cat-4'), PlacementTestVersion::query()->findOrFail($this->testVersionId), $component, ucfirst($component), $component, ['grammar' => 0, 'reading' => 1, 'listening' => 2][$component], 15, 'digital', true, 'plc-'.$component.'-section');
            $sectionId = $section['section_id'];
            $this->sectionIds[$component] = $sectionId;
            $sec = PlacementSection::query()->findOrFail($sectionId);
            $catalog->transitionSection($this->placementOfficer('plc-cat-5'), $sec, 'published', 'plc-'.$component.'-section-pub');

            foreach (['a', 'b'] as $index) {
                $q = $catalog->defineQuestion($this->placementOfficer('plc-cat-6'), $sec, $component.'-'.$index, ucfirst($component).' question '.$index, 'mcq', 1, null, 'A', null, 'plc-'.$component.'-q-'.$index);
                $question = PlacementQuestion::query()->findOrFail($q['question_id']);
                $catalog->transitionQuestion($this->placementOfficer('plc-cat-7'), $question, 'published', 'plc-'.$component.'-q-'.$index.'-pub');
                $this->questions[$question->id] = $component;
            }
            $this->addRubric($catalog, $component);
        }

        // Productive sections that require professional marking.
        foreach (['writing', 'speaking'] as $component) {
            $section = $catalog->defineSection($this->placementOfficer('plc-cat-8'), PlacementTestVersion::query()->findOrFail($this->testVersionId), $component, ucfirst($component), $component, ['writing' => 3, 'speaking' => 4][$component], 20, 'digital', false, 'plc-'.$component.'-section');
            $this->sectionIds[$component] = $section['section_id'];
            $sec = PlacementSection::query()->findOrFail($section['section_id']);
            $catalog->transitionSection($this->placementOfficer('plc-cat-9'), $sec, 'published', 'plc-'.$component.'-section-pub');
            $q = $catalog->defineQuestion($this->placementOfficer('plc-cat-10'), $sec, $component.'-task', ucfirst($component).' task', 'essay', 10, null, null, null, 'plc-'.$component.'-q');
            $question = PlacementQuestion::query()->findOrFail($q['question_id']);
            $catalog->transitionQuestion($this->placementOfficer('plc-cat-11'), $question, 'published', 'plc-'.$component.'-q-pub');
            $this->questions[$question->id] = $component;
            $this->addRubric($catalog, $component);
        }

        $catalog->publishVersion($this->placementOfficer('plc-cat-12'), PlacementTestVersion::query()->findOrFail($this->testVersionId), 'plc-version-pub');
    }

    private function addRubric(MaintainPlacementCatalog $catalog, string $component): void
    {
        foreach ([['A1', 0, 39.99, 'A1'], ['A2', 40, 54.99, 'A2'], ['B1', 55, 69.99, 'B1'], ['B2', 70, 84.99, 'B2'], ['C1', 85, 100, 'C1']] as [$band, $min, $max, $cefr]) {
            $rubric = $catalog->defineRubric($this->placementOfficer('plc-cat-20'), PlacementTestVersion::query()->findOrFail($this->testVersionId), $component, $band, $min, $max, $cefr, $component.' '.$band.' band', 'plc-'.$component.'-rubric-'.$band);
            $catalog->transitionRubric($this->placementOfficer('plc-cat-21'), PlacementRubric::query()->findOrFail($rubric['rubric_id']), 'published', 'plc-'.$component.'-rubric-'.$band.'-pub');
        }
    }

    public function test_full_placement_decision_lifecycle_is_server_authoritative_and_explainable(): void
    {
        $this->setUpPlacementCatalog();
        $person = $this->personWithAuthority('plc-person-1', []);
        $profileResult = app(ManagePlacementProfile::class)->openProfile(
            $this->placementOfficer('plc-open-1'),
            $person->id,
            $this->programVersionId,
            'plc-open',
        );
        $profile = PlacementProfile::query()->findOrFail($profileResult['profile_id']);

        $attemptResult = app(ManagePlacementProfile::class)->startAttempt(
            $this->placementOfficer('plc-attempt-1'),
            $profile,
            $this->testVersionId,
            'digital',
            'plc-start',
        );
        $attempt = PlacementAttempt::query()->findOrFail($attemptResult['attempt_id']);
        $this->assertSame('in_progress', $attempt->status);

        $answers = [];
        foreach ($this->questions as $questionId => $component) {
            $answers[$questionId] = in_array($component, ['grammar', 'reading', 'listening'], true) ? 'A' : 'sample response';
        }
        // Give the productive components their manual scores after submission.
        $submit = app(ManagePlacementProfile::class)->submitDigital($this->placementOfficer('plc-submit-1'), $attempt, $answers, 'plc-submit');
        $this->assertFalse($submit['tamper_flagged']);
        $this->assertNotNull($attempt->fresh()->anti_tamper_hmac);
        $this->assertSame('submitted', $attempt->fresh()->status);

        foreach (['writing', 'speaking'] as $component) {
            $sectionId = $this->sectionIds[$component];
            $result = PlacementSectionResult::query()->where('attempt_id', $attempt->id)->where('section_id', $sectionId)->firstOrFail();
            $rubric = PlacementRubric::query()->where('test_version_id', $this->testVersionId)->where('component', $component)->where('cefr_ref', 'B1')->firstOrFail();
            app(ScorePlacement::class)->scoreSection($this->placementOfficer('plc-mark-'.$component), $attempt, $sectionId, 60.0, $rubric->id, 'B1', 'professional marking', 'plc-mark-'.$component);
        }

        app(ManagePlacementProfile::class)->markScored($this->placementOfficer('plc-scored-1'), $profile, 'plc-scored');
        $this->assertSame('scored', $profile->fresh()->lifecycle_state);

        // A recommendation is generated after scoring, before section review.
        $recommendation = app(RecommendPlacement::class)->recommend($this->placementRecommender('plc-rec-1'), $profile, 'plc-rec');
        $this->assertSame('recommended', $profile->fresh()->lifecycle_state);
        $rec = PlacementRecommendation::query()->findOrFail($recommendation['recommendation_id']);
        $this->assertNotEmpty($rec->rationale);
        $this->assertNotEmpty($rec->score_snapshot['overall_cefr']);
        $this->assertSame((string) $rec->recommended_level_id, (string) $profile->fresh()->recommended_level_id);

        // Review/decision is refused while any section is unapproved.
        try {
            app(DecidePlacement::class)->review($this->placementModerator('plc-review-1'), $profile, 'plc-review');
            $this->fail('a placement review before section approval must be rejected');
        } catch (BusinessRejection $rejection) {
            $this->assertSame('placement.review_sections_not_approved', $rejection->errorCode());
        }

        foreach (PlacementSectionResult::query()->where('attempt_id', $attempt->id)->get() as $sectionResult) {
            $moderator = $this->placementModerator($this->actorId('plc-mod'));
            $approver = $this->placementApprover($this->actorId('plc-appr'));
            app(ScorePlacement::class)->moderateSection($moderator, $sectionResult, 'plc-mod-'.$sectionResult->id);
            app(ScorePlacement::class)->approveSection($approver, $sectionResult->fresh(), 'plc-appr-'.$sectionResult->id);
        }

        // The decision chain proceeds after recommendation and section approval.
        app(DecidePlacement::class)->review($this->placementModerator('plc-review-2'), $profile, 'plc-review2');
        app(DecidePlacement::class)->approve($this->placementApprover('plc-app-1'), $profile, 'plc-app');
        app(DecidePlacement::class)->release($this->placementReleaser('plc-rel-1'), $profile, 'plc-rel');
        $this->assertSame('released', $profile->fresh()->lifecycle_state);
        $this->assertSame(1, PlacementRecommendation::query()->where('profile_id', $profile->id)->count());
    }

    public function test_submitted_responses_and_recommendations_are_immutable(): void
    {
        $this->setUpPlacementCatalog();
        $person = $this->personWithAuthority('plc-person-2', []);
        $profile = PlacementProfile::query()->findOrFail(app(ManagePlacementProfile::class)->openProfile($this->placementOfficer('plc-open-2'), $person->id, $this->programVersionId, 'plc-open-2')['profile_id']);
        $attempt = PlacementAttempt::query()->findOrFail(app(ManagePlacementProfile::class)->startAttempt($this->placementOfficer('plc-attempt-2'), $profile, $this->testVersionId, 'digital', 'plc-start-2')['attempt_id']);
        $answers = [];
        foreach ($this->questions as $questionId => $component) {
            $answers[$questionId] = in_array($component, ['grammar', 'reading', 'listening'], true) ? 'A' : 'sample';
        }
        app(ManagePlacementProfile::class)->submitDigital($this->placementOfficer('plc-submit-2'), $attempt, $answers, 'plc-submit-2');

        $response = PlacementResponse::query()->where('attempt_id', $attempt->id)->firstOrFail();
        $this->expectException(QueryException::class);
        $response->update(['response_value' => 'changed']);
    }

    public function test_retake_requires_superseding_the_live_profile(): void
    {
        $this->setUpPlacementCatalog();
        $person = $this->personWithAuthority('plc-person-3', []);
        $profile = PlacementProfile::query()->findOrFail(app(ManagePlacementProfile::class)->openProfile($this->placementOfficer('plc-open-3'), $person->id, $this->programVersionId, 'plc-open-3')['profile_id']);
        $attempt = PlacementAttempt::query()->findOrFail(app(ManagePlacementProfile::class)->startAttempt($this->placementOfficer('plc-attempt-3'), $profile, $this->testVersionId, 'digital', 'plc-start-3')['attempt_id']);
        $answers = [];
        foreach ($this->questions as $questionId => $component) {
            $answers[$questionId] = in_array($component, ['grammar', 'reading', 'listening'], true) ? 'A' : 'sample';
        }
        app(ManagePlacementProfile::class)->submitDigital($this->placementOfficer('plc-submit-3'), $attempt, $answers, 'plc-submit-3');
        foreach (['writing', 'speaking'] as $component) {
            $sectionId = $this->sectionIds[$component];
            $result = PlacementSectionResult::query()->where('attempt_id', $attempt->id)->where('section_id', $sectionId)->firstOrFail();
            $rubric = PlacementRubric::query()->where('test_version_id', $this->testVersionId)->where('component', $component)->where('cefr_ref', 'B1')->firstOrFail();
            app(ScorePlacement::class)->scoreSection($this->placementOfficer('plc-mark-3-'.$component), $attempt, $sectionId, 60.0, $rubric->id, 'B1', 'professional marking', 'plc-mark-3-'.$component);
        }
        app(ManagePlacementProfile::class)->markScored($this->placementOfficer('plc-scored-3'), $profile, 'plc-scored-3');
        foreach (PlacementSectionResult::query()->where('attempt_id', $attempt->id)->get() as $r) {
            $moderator = $this->placementModerator($this->actorId('plc-mod3'));
            $approver = $this->placementApprover($this->actorId('plc-appr3'));
            app(ScorePlacement::class)->moderateSection($moderator, $r, 'plc-mod3-'.$r->id);
            app(ScorePlacement::class)->approveSection($approver, $r->fresh(), 'plc-appr3-'.$r->id);
        }
        app(RecommendPlacement::class)->recommend($this->placementRecommender('plc-rec-3'), $profile, 'plc-rec-3');
        app(DecidePlacement::class)->review($this->placementModerator('plc-review-3'), $profile, 'plc-review-3');
        app(DecidePlacement::class)->approve($this->placementApprover('plc-appr3-1'), $profile, 'plc-appr3-1');
        app(DecidePlacement::class)->release($this->placementReleaser('plc-rel-3'), $profile, 'plc-rel-3');

        // A second open profile is blocked while one is live.
        try {
            app(ManagePlacementProfile::class)->openProfile($this->placementOfficer('plc-open-3b'), $person->id, $this->programVersionId, 'plc-open-3b');
            $this->fail('a live profile must block a retake until superseded');
        } catch (BusinessRejection $rejection) {
            $this->assertSame('placement.profile_open_exists', $rejection->errorCode());
        }

        app(DecidePlacement::class)->supersede($this->placementReleaser('plc-super-3'), $profile, 'plc-super-3');
        $this->assertSame('superseded', $profile->fresh()->lifecycle_state);
        $retake = PlacementProfile::query()->findOrFail(app(ManagePlacementProfile::class)->openProfile($this->placementOfficer('plc-open-3c'), $person->id, $this->programVersionId, 'plc-open-3c')['profile_id']);
        $this->assertNotSame($profile->id, $retake->id);
    }

    public function test_placement_attempt_traces_back_to_the_crm_lead(): void
    {
        $this->setUpPlacementCatalog();
        $reception = $this->actorWithStructureCapabilities('plc-crm-1', ['crm.visitor']);
        $person = $this->personWithAuthority('plc-person-4', []);
        $visitor = app(CaptureVisitor::class)->capture($reception, null, 'Placement Lead', null, 'plc@example.com', 'email', 'online', null, null, null, null, null, 'plc-capture');
        app(LinkVisitorPerson::class)->link($reception, Visitor::query()->findOrFail($visitor['visitor_id']), $person->id, 'plc-link');

        $profile = PlacementProfile::query()->findOrFail(app(ManagePlacementProfile::class)->openProfile($this->placementOfficer('plc-open-4'), $person->id, $this->programVersionId, 'plc-open-4')['profile_id']);
        $attempt = PlacementAttempt::query()->findOrFail(app(ManagePlacementProfile::class)->startAttempt($this->placementOfficer('plc-attempt-4'), $profile, $this->testVersionId, 'digital', 'plc-start-4')['attempt_id']);
        $answers = [];
        foreach ($this->questions as $questionId => $component) {
            $answers[$questionId] = in_array($component, ['grammar', 'reading', 'listening'], true) ? 'A' : 'sample';
        }
        app(ManagePlacementProfile::class)->submitDigital($this->placementOfficer('plc-submit-4'), $attempt, $answers, 'plc-submit-4');

        $this->assertDatabaseHas('visitor_interactions', [
            'visitor_id' => $visitor['visitor_id'],
            'type' => 'placement',
            'placement_attempt_id' => $attempt->id,
        ]);
    }

    private function actorId(string $prefix): string
    {
        return $prefix.'-'.(++$this->actorSequence).'-'.substr((string) microtime(), -4);
    }

    public function test_recommendation_requires_a_scored_attempt(): void
    {
        $this->setUpPlacementCatalog();
        $person = $this->personWithAuthority('plc-person-5', []);
        $profile = PlacementProfile::query()->findOrFail(app(ManagePlacementProfile::class)->openProfile($this->placementOfficer('plc-open-5'), $person->id, $this->programVersionId, 'plc-open-5')['profile_id']);

        try {
            app(RecommendPlacement::class)->recommend($this->placementRecommender('plc-rec-5'), $profile, 'plc-rec-5');
            $this->fail('a draft profile must not produce a recommendation');
        } catch (BusinessRejection $rejection) {
            $this->assertSame('placement.recommend_requires_scored', $rejection->errorCode());
        }
    }
}
