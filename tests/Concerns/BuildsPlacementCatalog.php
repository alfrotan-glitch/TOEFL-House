<?php

declare(strict_types=1);

namespace Tests\Concerns;

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
use App\Modules\Academic\Placement\Models\PlacementRubric;
use App\Modules\Academic\Placement\Models\PlacementSection;
use App\Modules\Academic\Placement\Models\PlacementSectionResult;
use App\Modules\Academic\Placement\Models\PlacementTest;
use App\Modules\Academic\Placement\Models\PlacementTestVersion;

/**
 * Shared fixture builder for the Placement Decision System: a published
 * digital test (with auto-scored and professionally-marked sections) and a
 * physical auto-scored test, plus a helper that walks a placement all the way
 * to released. Uses the same authoritative commands production executes.
 */
trait BuildsPlacementCatalog
{
    use BuildsActors;

    private int $actorSequence = 0;

    private string $programVersionId;

    private string $testVersionId;

    private string $physicalVersionId = '';

    /** @var array<string, string> */
    private array $physicalQuestions = [];

    /** @var array<string, string> */
    private array $questions = [];

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

    private function actorId(string $prefix): string
    {
        return $prefix.'-'.(++$this->actorSequence).'-'.substr((string) microtime(), -4);
    }

    private function setUpPhysicalAutoCatalog(): void
    {
        $catalog = app(MaintainPlacementCatalog::class);
        $test = $catalog->defineTest(
            $this->placementOfficer('plc-phys-cat-1'),
            'placement-physical',
            'Physical Placement',
            $this->programVersionId,
            90,
            ['grammar' => 20, 'reading' => 20, 'listening' => 20, 'writing' => 20, 'speaking' => 20],
            'plc-phys-test-1',
        );
        $catalog->transitionTest($this->placementOfficer('plc-phys-cat-2'), PlacementTest::query()->findOrFail($test['test_id']), 'published', 'plc-phys-test-pub');
        $version = $catalog->createVersion($this->placementOfficer('plc-phys-cat-3'), PlacementTest::query()->findOrFail($test['test_id']), 'physical v1', 'plc-phys-ver');
        $this->physicalVersionId = $version['version_id'];

        foreach (['grammar', 'reading', 'listening'] as $component) {
            $section = $catalog->defineSection(
                $this->placementOfficer('plc-phys-cat-4'),
                PlacementTestVersion::query()->findOrFail($version['version_id']),
                $component,
                ucfirst($component),
                $component,
                ['grammar' => 0, 'reading' => 1, 'listening' => 2][$component],
                15,
                'physical',
                true,
                'plc-phys-'.$component.'-section',
            );
            $sec = PlacementSection::query()->findOrFail($section['section_id']);
            $catalog->transitionSection($this->placementOfficer('plc-phys-cat-5'), $sec, 'published', 'plc-phys-'.$component.'-section-pub');
            foreach (['a', 'b'] as $index) {
                $q = $catalog->defineQuestion($this->placementOfficer('plc-phys-cat-6'), $sec, $component.'-'.$index, ucfirst($component).' question '.$index, 'mcq', 1, null, 'A', null, 'plc-phys-'.$component.'-q-'.$index);
                $question = PlacementQuestion::query()->findOrFail($q['question_id']);
                $catalog->transitionQuestion($this->placementOfficer('plc-phys-cat-7'), $question, 'published', 'plc-phys-'.$component.'-q-'.$index.'-pub');
                $this->physicalQuestions[$question->id] = $component;
            }
        }
        $catalog->publishVersion($this->placementOfficer('plc-phys-cat-8'), PlacementTestVersion::query()->findOrFail($version['version_id']), 'plc-phys-version-pub');
    }

    private function completeReleasedPlacement(string $personId, string $prefix): PlacementProfile
    {
        $profile = PlacementProfile::query()->findOrFail(app(ManagePlacementProfile::class)->openProfile(
            $this->placementOfficer($this->actorId($prefix.'-open')),
            $personId,
            $this->programVersionId,
            $prefix.'-open',
        )['profile_id']);
        $attempt = PlacementAttempt::query()->findOrFail(app(ManagePlacementProfile::class)->startAttempt(
            $this->placementOfficer($this->actorId($prefix.'-start')),
            $profile,
            $this->testVersionId,
            'digital',
            $prefix.'-start',
        )['attempt_id']);
        $answers = [];
        foreach ($this->questions as $questionId => $component) {
            $answers[$questionId] = in_array($component, ['grammar', 'reading', 'listening'], true) ? 'A' : 'sample';
        }
        app(ManagePlacementProfile::class)->submitDigital($this->placementOfficer($this->actorId($prefix.'-submit')), $attempt, $answers, $prefix.'-submit');
        foreach (['writing', 'speaking'] as $component) {
            $sectionId = $this->sectionIds[$component];
            $result = PlacementSectionResult::query()->where('attempt_id', $attempt->id)->where('section_id', $sectionId)->firstOrFail();
            $rubric = PlacementRubric::query()->where('test_version_id', $this->testVersionId)->where('component', $component)->where('cefr_ref', 'B1')->firstOrFail();
            app(ScorePlacement::class)->scoreSection($this->placementOfficer($this->actorId($prefix.'-mark-'.$component)), $attempt, $sectionId, 60.0, $rubric->id, 'B1', 'professional marking', $prefix.'-mark-'.$component);
        }
        app(ManagePlacementProfile::class)->markScored($this->placementOfficer($this->actorId($prefix.'-scored')), $profile, $prefix.'-scored');
        foreach (PlacementSectionResult::query()->where('attempt_id', $attempt->id)->get() as $sectionResult) {
            app(ScorePlacement::class)->moderateSection($this->placementModerator($this->actorId($prefix.'-mod')), $sectionResult, $prefix.'-mod-'.$sectionResult->id);
            app(ScorePlacement::class)->approveSection($this->placementApprover($this->actorId($prefix.'-appr')), $sectionResult->fresh(), $prefix.'-appr-'.$sectionResult->id);
        }
        app(RecommendPlacement::class)->recommend($this->placementRecommender($this->actorId($prefix.'-rec')), $profile, $prefix.'-rec');
        app(DecidePlacement::class)->review($this->placementModerator($this->actorId($prefix.'-review')), $profile, $prefix.'-review');
        app(DecidePlacement::class)->approve($this->placementApprover($this->actorId($prefix.'-approve')), $profile, $prefix.'-approve');
        app(DecidePlacement::class)->release($this->placementReleaser($this->actorId($prefix.'-release')), $profile, $prefix.'-release');
        $this->assertSame('released', $profile->fresh()->lifecycle_state);

        return $profile->fresh();
    }
}
