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
use App\Modules\Organization\Models\Branch;
use App\Support\Identifiers\RandomIdentifier;

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

    /** Operational branch shared by every placement catalog/profile fact. */
    private string $placementBranchId = '';

    private string $testVersionId;

    private string $physicalVersionId = '';

    private string $physicalProfessionalVersionId = '';

    /** @var array<string, string> */
    private array $physicalQuestions = [];

    /** @var array<string, string> */
    private array $physicalProfessionalQuestions = [];

    /** @var array<string, string> */
    private array $questions = [];

    /** @var array<string, string> */
    private array $sectionIds = [];

    private function setUpPlacementCatalog(): void
    {
        $this->ensurePlacementBranch();
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
            $this->placementBranchId,
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

            foreach (['a', 'b'] as $index) {
                $q = $catalog->defineQuestion($this->placementOfficer('plc-cat-6'), $sec, $component.'-'.$index, ucfirst($component).' question '.$index, 'mcq', 1, null, 'A', 'plc-'.$component.'-q-'.$index);
                $question = PlacementQuestion::query()->findOrFail($q['question_id']);
                if ($component === 'grammar' && $index === 'a') {
                    $catalog->attachMedia(
                        $this->placementOfficer('plc-cat-media'),
                        $question,
                        'placement-media/grammar-a.mp3',
                        'audio',
                        hash('sha256', 'placement-media/grammar-a.mp3/v1'),
                        'audio/mpeg',
                        'plc-grammar-a-media',
                    );
                }
                $catalog->transitionQuestion($this->placementOfficer('plc-cat-7'), $question, 'published', 'plc-'.$component.'-q-'.$index.'-pub');
                $this->questions[$question->id] = $component;
            }
            $this->addRubric($catalog, $component);
            $catalog->transitionSection($this->placementOfficer('plc-cat-5'), PlacementSection::query()->findOrFail($sectionId), 'published', 'plc-'.$component.'-section-pub');
        }

        // Productive sections that require professional marking.
        foreach (['writing', 'speaking'] as $component) {
            $section = $catalog->defineSection($this->placementOfficer('plc-cat-8'), PlacementTestVersion::query()->findOrFail($this->testVersionId), $component, ucfirst($component), $component, ['writing' => 3, 'speaking' => 4][$component], 20, 'digital', false, 'plc-'.$component.'-section');
            $this->sectionIds[$component] = $section['section_id'];
            $sec = PlacementSection::query()->findOrFail($section['section_id']);
            $q = $catalog->defineQuestion($this->placementOfficer('plc-cat-10'), $sec, $component.'-task', ucfirst($component).' task', 'essay', 10, null, null, 'plc-'.$component.'-q');
            $question = PlacementQuestion::query()->findOrFail($q['question_id']);
            $catalog->transitionQuestion($this->placementOfficer('plc-cat-11'), $question, 'published', 'plc-'.$component.'-q-pub');
            $this->questions[$question->id] = $component;
            $this->addRubric($catalog, $component);
            $catalog->transitionSection($this->placementOfficer('plc-cat-9'), PlacementSection::query()->findOrFail($section['section_id']), 'published', 'plc-'.$component.'-section-pub');
        }

        $catalog->publishVersion($this->placementOfficer('plc-cat-12'), PlacementTestVersion::query()->findOrFail($this->testVersionId), 'plc-version-pub');
    }

    private function addRubric(MaintainPlacementCatalog $catalog, string $component, ?string $versionId = null, string $fixturePrefix = 'plc'): void
    {
        $versionId ??= $this->testVersionId;
        foreach ([['A1', 0, 39.99, 'A1'], ['A2', 40, 54.99, 'A2'], ['B1', 55, 69.99, 'B1'], ['B2', 70, 84.99, 'B2'], ['C1', 85, 100, 'C1']] as [$band, $min, $max, $cefr]) {
            $rubric = $catalog->defineRubric($this->placementOfficer($fixturePrefix.'-cat-20'), PlacementTestVersion::query()->findOrFail($versionId), $component, $band, $min, $max, $cefr, $component.' '.$band.' band', $fixturePrefix.'-'.$component.'-rubric-'.$band);
            $catalog->transitionRubric($this->placementOfficer($fixturePrefix.'-cat-21'), PlacementRubric::query()->findOrFail($rubric['rubric_id']), 'published', $fixturePrefix.'-'.$component.'-rubric-'.$band.'-pub');
        }
    }

    private function actorId(string $prefix): string
    {
        return $prefix.'-'.(++$this->actorSequence).'-'.substr((string) microtime(), -4);
    }

    private function ensurePlacementBranch(): void
    {
        if ($this->placementBranchId !== '') {
            return;
        }
        $branch = Branch::query()->create([
            'id' => RandomIdentifier::new(),
            'name' => 'Placement Fixture Branch',
            'lifecycle_state' => 'active',
        ]);
        $this->placementBranchId = $branch->id;
        $this->attachBranchToBootstrapOrganization($branch->id);
        $this->grantKnownAuthorityOn('branch', $branch->id);
    }

    private function setUpPhysicalAutoCatalog(): void
    {
        $this->ensurePlacementBranch();
        $catalog = app(MaintainPlacementCatalog::class);
        $test = $catalog->defineTest(
            $this->placementOfficer('plc-phys-cat-1'),
            'placement-physical',
            'Physical Placement',
            $this->programVersionId,
            90,
            ['grammar' => 20, 'reading' => 20, 'listening' => 20, 'writing' => 20, 'speaking' => 20],
            'plc-phys-test-1',
            $this->placementBranchId,
        );
        $catalog->transitionTest($this->placementOfficer('plc-phys-cat-2'), PlacementTest::query()->findOrFail($test['test_id']), 'published', 'plc-phys-test-pub');
        $version = $catalog->createVersion($this->placementOfficer('plc-phys-cat-3'), PlacementTest::query()->findOrFail($test['test_id']), 'physical v1', 'plc-phys-ver');
        $this->physicalVersionId = $version['version_id'];

        // Physical delivery still needs the complete five-component scoring
        // contract. It is all auto-scored so this fixture exercises the
        // proctored evidence path without duplicating professional marking.
        foreach (['grammar', 'reading', 'listening', 'writing', 'speaking'] as $order => $component) {
            $section = $catalog->defineSection(
                $this->placementOfficer('plc-phys-cat-4'),
                PlacementTestVersion::query()->findOrFail($version['version_id']),
                $component,
                ucfirst($component),
                $component,
                $order,
                15,
                'physical',
                true,
                'plc-phys-'.$component.'-section',
            );
            $sec = PlacementSection::query()->findOrFail($section['section_id']);
            foreach (['a', 'b'] as $index) {
                $q = $catalog->defineQuestion($this->placementOfficer('plc-phys-cat-6'), $sec, $component.'-'.$index, ucfirst($component).' question '.$index, 'mcq', 1, null, 'A', 'plc-phys-'.$component.'-q-'.$index);
                $question = PlacementQuestion::query()->findOrFail($q['question_id']);
                $catalog->transitionQuestion($this->placementOfficer('plc-phys-cat-7'), $question, 'published', 'plc-phys-'.$component.'-q-'.$index.'-pub');
                $this->physicalQuestions[$question->id] = $component;
            }
            $this->addRubric($catalog, $component, $this->physicalVersionId, 'plc-phys');
            $catalog->transitionSection($this->placementOfficer('plc-phys-cat-5'), PlacementSection::query()->findOrFail($section['section_id']), 'published', 'plc-phys-'.$component.'-section-pub');
        }
        $catalog->publishVersion($this->placementOfficer('plc-phys-cat-8'), PlacementTestVersion::query()->findOrFail($version['version_id']), 'plc-phys-version-pub');
    }

    /**
     * A valid all-professionally-marked physical version. Its paper/recording
     * is the authoritative evidence, so it deliberately has no answer key or
     * normalized responses. This proves that evidence-only physical intake is
     * a reachable governed workflow rather than a legacy escape hatch.
     */
    private function setUpPhysicalProfessionalCatalog(): void
    {
        $this->ensurePlacementBranch();
        $catalog = app(MaintainPlacementCatalog::class);
        $test = $catalog->defineTest(
            $this->placementOfficer('plc-physical-prof-cat-1'),
            'placement-physical-professional',
            'Professionally Marked Physical Placement',
            $this->programVersionId,
            90,
            ['grammar' => 20, 'reading' => 20, 'listening' => 20, 'writing' => 20, 'speaking' => 20],
            'plc-physical-prof-test-1',
            $this->placementBranchId,
        );
        $catalog->transitionTest($this->placementOfficer('plc-physical-prof-cat-2'), PlacementTest::query()->findOrFail($test['test_id']), 'published', 'plc-physical-prof-test-pub');
        $version = $catalog->createVersion($this->placementOfficer('plc-physical-prof-cat-3'), PlacementTest::query()->findOrFail($test['test_id']), 'professionally marked physical v1', 'plc-physical-prof-ver');
        $this->physicalProfessionalVersionId = $version['version_id'];

        foreach (['grammar', 'reading', 'listening', 'writing', 'speaking'] as $order => $component) {
            $section = $catalog->defineSection(
                $this->placementOfficer('plc-physical-prof-cat-4'),
                PlacementTestVersion::query()->findOrFail($version['version_id']),
                $component,
                ucfirst($component),
                $component,
                $order,
                15,
                'physical',
                false,
                'plc-physical-prof-'.$component.'-section',
            );
            $sectionRecord = PlacementSection::query()->findOrFail($section['section_id']);
            // A short-answer item has no server key in a professional physical
            // section; the proctored artifact and accountable marker govern it.
            $question = $catalog->defineQuestion(
                $this->placementOfficer('plc-physical-prof-cat-6'),
                $sectionRecord,
                $component.'-prompt',
                ucfirst($component).' professionally marked prompt',
                'short_answer',
                1,
                null,
                null,
                'plc-physical-prof-'.$component.'-q',
            );
            $questionRecord = PlacementQuestion::query()->findOrFail($question['question_id']);
            $catalog->transitionQuestion($this->placementOfficer('plc-physical-prof-cat-7'), $questionRecord, 'published', 'plc-physical-prof-'.$component.'-q-pub');
            $this->physicalProfessionalQuestions[$questionRecord->id] = $component;
            $this->addRubric($catalog, $component, $this->physicalProfessionalVersionId, 'plc-physical-prof');
            $catalog->transitionSection($this->placementOfficer('plc-physical-prof-cat-5'), $sectionRecord, 'published', 'plc-physical-prof-'.$component.'-section-pub');
        }
        $catalog->publishVersion($this->placementOfficer('plc-physical-prof-cat-8'), PlacementTestVersion::query()->findOrFail($version['version_id']), 'plc-physical-prof-version-pub');
    }

    private function completeReleasedPlacement(string $personId, string $prefix): PlacementProfile
    {
        return $this->completePlacement($personId, $prefix, true);
    }

    /** Builds a decision through independent approval but does not release it. */
    private function completeApprovedPlacement(string $personId, string $prefix): PlacementProfile
    {
        return $this->completePlacement($personId, $prefix, false);
    }

    private function completePlacement(string $personId, string $prefix, bool $release): PlacementProfile
    {
        $profile = PlacementProfile::query()->findOrFail(app(ManagePlacementProfile::class)->openProfile(
            $this->placementOfficer($this->actorId($prefix.'-open')),
            $personId,
            $this->programVersionId,
            $prefix.'-open',
            null,
            $this->placementBranchId,
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
            $approved = $sectionResult->fresh();
            if ($approved === null) {
                $this->fail('placement section result disappeared before approval');
            }
            app(ScorePlacement::class)->approveSection($this->placementApprover($this->actorId($prefix.'-appr')), $approved, $prefix.'-appr-'.$sectionResult->id);
        }
        app(RecommendPlacement::class)->recommend($this->placementRecommender($this->actorId($prefix.'-rec')), $profile, $prefix.'-rec');
        app(DecidePlacement::class)->review($this->placementModerator($this->actorId($prefix.'-review')), $profile, $prefix.'-review');
        app(DecidePlacement::class)->approve($this->placementApprover($this->actorId($prefix.'-approve')), $profile, $prefix.'-approve');
        if (! $release) {
            $approved = $profile->fresh();
            if ($approved === null) {
                $this->fail('placement profile disappeared after approval');
            }
            $this->assertSame('approved', $approved->lifecycle_state);

            return $approved;
        }

        app(DecidePlacement::class)->release($this->placementReleaser($this->actorId($prefix.'-release')), $profile, $prefix.'-release');
        $released = $profile->fresh();
        if ($released === null) {
            $this->fail('placement profile disappeared after release');
        }
        $this->assertSame('released', $released->lifecycle_state);

        return $released;
    }
}
