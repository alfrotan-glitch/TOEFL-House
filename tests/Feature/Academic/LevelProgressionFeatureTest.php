<?php

declare(strict_types=1);

namespace Tests\Feature\Academic;

use App\Modules\Academic\Commands\DecideProgression;
use App\Modules\Academic\Commands\MaintainAcademicStructure;
use App\Modules\Academic\Commands\MaintainClass;
use App\Modules\Academic\Commands\MaintainEnrollment;
use App\Modules\Academic\Commands\ManageAcademicOffering;
use App\Modules\Academic\Commands\ManageAssessmentResult;
use App\Modules\Academic\Models\AcademicPeriod;
use App\Modules\Academic\Models\AssessmentAttempt;
use App\Modules\Academic\Models\AssessmentResult;
use App\Modules\Academic\Models\ClassModel;
use App\Modules\Academic\Models\Enrollment;
use App\Modules\Academic\Models\LevelPrerequisite;
use App\Modules\Academic\Models\Offering;
use App\Modules\Academic\Models\Program;
use App\Modules\Academic\Models\ProgressionDecision;
use App\Modules\Academic\Queries\AcademicHistoryQuery;
use App\Modules\Academic\Queries\OfferingCatalogQuery;
use App\Modules\Admissions\Commands\EnrollAdmittedApplicant;
use App\Modules\Admissions\Commands\RegisterApplicant;
use App\Modules\Admissions\Models\Applicant;
use App\Modules\Finance\Commands\MaintainFinancialPeriod;
use App\Modules\Finance\Commands\PostObligation;
use App\Modules\Finance\Models\FinancialPeriod;
use App\Modules\Organization\Models\Branch;
use App\Support\Authorization\Actor;
use App\Support\Errors\BusinessRejection;
use App\Support\Identifiers\RandomIdentifier;
use Carbon\CarbonImmutable;
use Illuminate\Database\QueryException;
use Illuminate\Support\Facades\DB;
use Tests\Concerns\BuildsActors;
use Tests\Concerns\DecidesAdmissions;
use Tests\TestCase;

/**
 * AC4 level-aware progression, prerequisites, repeat/advance rules,
 * immutable academic history, and offering-linked Finance packaging
 * (ADR-018). Finance remains the sole authority: Academic never produces an
 * amount, it only publishes a validated offering reference.
 */
final class LevelProgressionFeatureTest extends TestCase
{
    use BuildsActors;
    use DecidesAdmissions;

    private string $programVersionId;

    private string $periodId;

    private string $branchId;

    private string $levelA1;

    private string $levelA2;

    private string $levelB1;

    private string $offeringA1;

    private string $offeringA2;

    private string $offeringB1;

    private string $classA1;

    private string $classA2;

    private string $classB1;

    protected function setUp(): void
    {
        parent::setUp();
        $this->personWithAuthority('lp-teacher-1', []);
        $structure = app(MaintainAcademicStructure::class);
        $officer = $this->academicOfficer('lp-officer');

        $program = $structure->defineProgram($officer, 'Level Progression Program', 'lp-prog');
        $this->programVersionId = $structure->publishVersion($officer, Program::query()->findOrFail($program['program_id']), 'lp-v1', 'lp-ver')['version_id'];

        $this->levelA1 = $structure->defineLevel($officer, $this->programVersionId, 'A1', 1, 'A1 level', 'A1', 'lp-lvl-a1')['level_id'];
        $this->levelA2 = $structure->defineLevel($officer, $this->programVersionId, 'A2', 2, 'A2 level', 'A2', 'lp-lvl-a2')['level_id'];
        $this->levelB1 = $structure->defineLevel($officer, $this->programVersionId, 'B1', 3, 'B1 level', 'B1', 'lp-lvl-b1')['level_id'];

        $this->periodId = $structure->definePeriod($officer, 'LP Term', new CarbonImmutable('2026-09-01'), new CarbonImmutable('2026-12-18'), 'lp-period')['period_id'];
        $structure->transitionPeriod($officer, AcademicPeriod::query()->findOrFail($this->periodId), 'published', 'lp-period-pub');

        $this->branchId = Branch::query()->create([
            'id' => RandomIdentifier::new(),
            'name' => 'LP Branch '.substr(md5(RandomIdentifier::new()), 0, 8),
            'lifecycle_state' => 'active',
        ])->id;

        $this->offeringA1 = $this->openOffering($structure, $officer, $this->levelA1, 'lp-off-a1');
        $this->offeringA2 = $this->openOffering($structure, $officer, $this->levelA2, 'lp-off-a2');
        $this->offeringB1 = $this->openOffering($structure, $officer, $this->levelB1, 'lp-off-b1');

        $this->classA1 = $this->defineActiveClass($structure, $officer, 'lp-class-a1', $this->levelA1);
        $this->classA2 = $this->defineActiveClass($structure, $officer, 'lp-class-a2', $this->levelA2);
        $this->classB1 = $this->defineActiveClass($structure, $officer, 'lp-class-b1', $this->levelB1);

        $structure->definePrerequisite($officer, $this->levelA2, $this->levelA1, 'lp-prereq-a1-a2');
    }

    public function test_prerequisite_fails_closed_at_enrollment_request(): void
    {
        $studentId = $this->newStudent('lp-student-prereq');

        try {
            app(MaintainEnrollment::class)->request($this->enrollmentClerk('lp-enroll-prereq'), $studentId, $this->classA2, 'lp-prereq-enroll');
            $this->fail('an unsatisfied level prerequisite must fail closed');
        } catch (BusinessRejection $rejection) {
            $this->assertSame('academic.enrollment_prerequisite_unsatisfied', $rejection->errorCode());
        }

        $this->assertDatabaseMissing('enrollments', ['student_id' => $studentId, 'class_id' => $this->classA2]);
    }

    public function test_level_aware_advance_writes_fact_unlocks_next_level_and_posts_offering_linked_obligation(): void
    {
        $structure = app(MaintainAcademicStructure::class);
        $officer = $this->academicOfficer('lp-officer-flow');
        $studentId = $this->newStudent('lp-student-advance');

        $a1EnrollmentId = $this->activate($studentId, $this->classA1, $this->offeringA1, 'lp-a1');

        /** @var ProgressionDecision $proposed */
        $decision = app(DecideProgression::class)->propose(
            $this->grantedActor('lp-proposer-adv', ['academic.progression_propose']),
            $studentId,
            $this->classA1,
            'advance',
            'completed all A1 requirements',
            'lp-propose-adv',
            null,
            'completed A1 curriculum and passed assessment evidence',
        );
        $decisionId = $decision['decision_id'];
        app(DecideProgression::class)->review($this->grantedActor('lp-reviewer-adv', ['academic.progression_review']), ProgressionDecision::query()->findOrFail($decisionId), 'lp-review-adv');
        app(DecideProgression::class)->approve($this->grantedActor('lp-approver-adv', ['academic.progression_approve']), ProgressionDecision::query()->findOrFail($decisionId), 'lp-approve-adv');

        $this->assertDatabaseHas('progression_decisions', [
            'id' => $decisionId,
            'lifecycle_state' => 'approved',
            'outcome' => 'advance',
            'from_level_id' => $this->levelA1,
            'to_level_id' => $this->levelA2,
            'basis' => 'completed A1 curriculum and passed assessment evidence',
        ]);
        $this->assertDatabaseHas('level_progress_facts', [
            'decision_id' => $decisionId,
            'student_id' => $studentId,
            'level_id' => $this->levelA1,
            'to_level_id' => $this->levelA2,
            'outcome' => 'advance',
            'class_id' => $this->classA1,
            'offering_id' => $this->offeringA1,
        ]);

        $current = (new AcademicHistoryQuery)->currentLevel($studentId, $this->programVersionId);
        $this->assertSame($this->levelA2, $current?->id);

        $factId = DB::table('level_progress_facts')->where('decision_id', $decisionId)->value('id');
        $this->expectException(QueryException::class);
        DB::statement('UPDATE level_progress_facts SET outcome = ? WHERE id = ?', ['repeat', $factId]);

        // The prerequisite gate is now satisfied by the immutable advance fact.
        $a2EnrollmentId = $this->activate($studentId, $this->classA2, $this->offeringA2, 'lp-a2');
        $this->assertNotNull($a2EnrollmentId);

        $financeOfficer = $this->grantedActor('lp-finance-officer', ['finance.period', 'finance.obligation']);
        $financialPeriodId = app(MaintainFinancialPeriod::class)->open($financeOfficer, '2026-09', '2026-09-01', '2026-09-30', 'lp-fin-period')['period_id'];
        $obligation = app(PostObligation::class)->post(
            $financeOfficer,
            FinancialPeriod::query()->findOrFail($financialPeriodId),
            $studentId,
            'tuition',
            'September tuition',
            [['category' => 'tuition', 'amount' => '1000.00', 'source_ref' => 'lp-price/v1']],
            'lp-ob-1',
            $this->offeringA2,
        );
        $this->assertDatabaseHas('obligations', ['id' => $obligation['obligation_id'], 'offering_id' => $this->offeringA2]);
    }

    public function test_repeat_stays_on_level_and_cap_is_server_enforced(): void
    {
        $structure = app(MaintainAcademicStructure::class);
        $officer = $this->academicOfficer('lp-officer-repeat');
        $structure->defineProgressionRule($officer, $this->levelA1, null, 1, 'lp-rule-repeat');

        $studentId = $this->newStudent('lp-student-repeat');
        $this->activate($studentId, $this->classA1, $this->offeringA1, 'lp-repeat');

        try {
            app(DecideProgression::class)->propose(
                $this->grantedActor('lp-proposer-repeat', ['academic.progression_propose']),
                $studentId,
                $this->classA1,
                'repeat',
                'needs remediation',
                'lp-propose-repeat-cap',
                null,
                'remediation evidence for A1',
                2,
            );
            $this->fail('a repeat beyond the configured cap must be refused');
        } catch (BusinessRejection $rejection) {
            $this->assertSame('academic.progression_repeat_cap', $rejection->errorCode());
        }

        $repeat = app(DecideProgression::class)->propose(
            $this->grantedActor('lp-proposer-repeat-ok', ['academic.progression_propose']),
            $studentId,
            $this->classA1,
            'repeat',
            'needs remediation',
            'lp-propose-repeat-ok',
            null,
            'remediation evidence for A1',
            1,
        );
        $decision = ProgressionDecision::query()->findOrFail($repeat['decision_id']);
        $this->assertSame($this->levelA1, $decision->from_level_id);
        $this->assertSame($this->levelA1, $decision->to_level_id);
        $this->assertSame(1, $decision->repeat_count);
    }

    public function test_advance_to_last_level_or_beyond_is_refused(): void
    {
        $studentId = $this->newStudent('lp-student-last');
        $this->activate($studentId, $this->classB1, $this->offeringB1, 'lp-last');

        try {
            app(DecideProgression::class)->propose(
                $this->grantedActor('lp-proposer-last', ['academic.progression_propose']),
                $studentId,
                $this->classB1,
                'advance',
                'completes B1',
                'lp-propose-last',
                null,
                'B1 completion evidence',
            );
            $this->fail('an advance past the final level must be refused');
        } catch (BusinessRejection $rejection) {
            $this->assertSame('academic.progression_advance_past_last', $rejection->errorCode());
        }
    }

    public function test_minimum_passing_score_rule_is_required_when_configured(): void
    {
        $structure = app(MaintainAcademicStructure::class);
        $officer = $this->academicOfficer('lp-officer-score');
        $structure->defineProgressionRule($officer, $this->levelA1, '70.00', null, 'lp-rule-score');

        $studentId = $this->newStudent('lp-student-score');
        $enrollmentId = $this->activate($studentId, $this->classA1, $this->offeringA1, 'lp-score');
        $below = $this->releasedResult($enrollmentId, 'lp-below', '55.00');
        $above = $this->releasedResult($enrollmentId, 'lp-above', '85.00');

        try {
            app(DecideProgression::class)->propose(
                $this->grantedActor('lp-proposer-score', ['academic.progression_propose']),
                $studentId,
                $this->classA1,
                'advance',
                'score-based advance',
                'lp-propose-score',
                $below['result_id'],
                'released result 55.00',
            );
            $this->fail('a result below the level minimum must be refused');
        } catch (BusinessRejection $rejection) {
            $this->assertSame('academic.progression_minimum_score', $rejection->errorCode());
        }

        try {
            app(DecideProgression::class)->propose(
                $this->grantedActor('lp-proposer-score-missing', ['academic.progression_propose']),
                $studentId,
                $this->classA1,
                'advance',
                'score-based advance',
                'lp-propose-score-missing',
                null,
                'score evidence not supplied',
            );
            $this->fail('a configured minimum score requires the result evidence');
        } catch (BusinessRejection $rejection) {
            $this->assertSame('academic.progression_result_required', $rejection->errorCode());
        }

        $decision = app(DecideProgression::class)->propose(
            $this->grantedActor('lp-proposer-score-ok', ['academic.progression_propose']),
            $studentId,
            $this->classA1,
            'advance',
            'score-based advance',
            'lp-propose-score-ok',
            $above['result_id'],
            'released result 85.00',
        );
        $this->assertDatabaseHas('progression_decisions', ['id' => $decision['decision_id'], 'assessment_result_id' => $above['result_id']]);
    }

    public function test_prerequisite_configuration_rejects_self_and_active_cycle(): void
    {
        $structure = app(MaintainAcademicStructure::class);
        $officer = $this->academicOfficer('lp-officer-cycle');

        try {
            $structure->definePrerequisite($officer, $this->levelA1, $this->levelA1, 'lp-prereq-self');
            $this->fail('a self prerequisite must be rejected');
        } catch (BusinessRejection $rejection) {
            $this->assertSame('academic.prerequisite_self', $rejection->errorCode());
        }

        try {
            $structure->definePrerequisite($officer, $this->levelA1, $this->levelA2, 'lp-prereq-cycle');
            $this->fail('an active cycle must be rejected');
        } catch (BusinessRejection $rejection) {
            $this->assertSame('academic.prerequisite_cycle', $rejection->errorCode());
        }

        $prerequisite = LevelPrerequisite::query()
            ->where('target_level_id', $this->levelA2)
            ->where('required_level_id', $this->levelA1)
            ->firstOrFail();
        $retired = $structure->retirePrerequisite($officer, $prerequisite, 'lp-prereq-retire');
        $this->assertSame('retired', $retired['lifecycle_state']);
        $this->assertDatabaseHas('level_prerequisites', ['id' => $prerequisite->id, 'lifecycle_state' => 'retired']);
    }

    public function test_obligation_rejects_cancelled_or_non_enrolled_offering(): void
    {
        $financeOfficer = $this->grantedActor('lp-finance-officer-invalid', ['finance.period', 'finance.obligation']);
        $financialPeriodId = app(MaintainFinancialPeriod::class)->open($financeOfficer, '2026-09', '2026-09-01', '2026-09-30', 'lp-fin-invalid-period')['period_id'];
        $period = FinancialPeriod::query()->findOrFail($financialPeriodId);
        $studentId = $this->newStudent('lp-student-offering');

        try {
            app(PostObligation::class)->post($financeOfficer, $period, $studentId, 'tuition', 'no seat', [
                ['category' => 'tuition', 'amount' => '100.00', 'source_ref' => 'x'],
            ], 'lp-ob-mismatch', $this->offeringB1);
            $this->fail('an offering without an active student enrollment must be refused');
        } catch (BusinessRejection $rejection) {
            $this->assertSame('finance.obligation_offering_enrollment_mismatch', $rejection->errorCode());
        }

        $manager = app(ManageAcademicOffering::class);
        $manager->cancelOffering($this->academicOfficer('lp-officer-cancel'), Offering::query()->findOrFail($this->offeringB1), 'lp-cancel-b1');

        try {
            app(PostObligation::class)->post($financeOfficer, $period, $studentId, 'tuition', 'cancelled seat', [
                ['category' => 'tuition', 'amount' => '100.00', 'source_ref' => 'x'],
            ], 'lp-ob-cancelled', $this->offeringB1);
            $this->fail('a cancelled offering must be refused');
        } catch (BusinessRejection $rejection) {
            $this->assertSame('finance.obligation_offering_invalid', $rejection->errorCode());
        }
    }

    public function test_offering_catalog_projects_level_and_prerequisite_config(): void
    {
        $catalogue = (new OfferingCatalogQuery)->catalogue($this->branchId, $this->periodId);
        $a2 = collect($catalogue['availabilities'])->firstWhere('program_version_level_id', $this->levelA2);

        $this->assertNotNull($a2);
        $this->assertSame('A2', $a2['level']['level_key']);
        $this->assertSame(2, $a2['level']['ordinal']);
        $this->assertSame([['required_level_id' => $this->levelA1, 'lifecycle_state' => 'active']], $a2['prerequisites']);
    }

    private function openOffering(MaintainAcademicStructure $structure, Actor $officer, string $levelId, string $key): string
    {
        $structure->declareBranchAvailability($officer, $this->branchId, $levelId, $this->periodId, $key.'-avail');

        return $structure->openOffering($officer, $this->branchId, $levelId, $this->periodId, 10, $key)['offering_id'];
    }

    private function defineActiveClass(MaintainAcademicStructure $structure, Actor $officer, string $key, string $levelId): string
    {
        $classId = app(MaintainClass::class)->defineClass($officer, $this->programVersionId, $this->periodId, 10, $key, $levelId)['class_id'];
        app(MaintainClass::class)->assignTeacher($officer, ClassModel::query()->findOrFail($classId), 'lp-teacher-1', new CarbonImmutable('2026-09-01'), null, $key.'-teacher');
        app(MaintainClass::class)->transition($officer, ClassModel::query()->findOrFail($classId), 'published', $key.'-pub');
        app(MaintainClass::class)->transition($officer, ClassModel::query()->findOrFail($classId), 'active', $key.'-active');

        return $classId;
    }

    private function newStudent(string $personId): string
    {
        $this->personWithAuthority($personId, []);
        $registered = app(RegisterApplicant::class)->register($this->admissionsClerk($personId.'-clerk'), $personId, 'Program', $personId.'-reg');
        /** @var Applicant $applicant */
        $applicant = Applicant::query()->findOrFail($registered['applicant_id']);
        $this->runAdmissionDecision(
            $this->admissionsClerk($personId.'-clerk'),
            $this->admissionsReviewer($personId.'-review'),
            $this->admissionsApprover($personId.'-approve'),
            $applicant,
            true,
            'meets policy',
            'ev/lp',
            $personId.'-adm',
        );

        return app(EnrollAdmittedApplicant::class)->convert($this->admissionsApprover($personId.'-approve'), $applicant, $personId.'-conv')['student_id'];
    }

    private function activate(string $studentId, string $classId, string $offeringId, string $prefix): string
    {
        $requested = app(MaintainEnrollment::class)->request($this->enrollmentClerk($prefix.'-enroll'), $studentId, $classId, $prefix.'-enroll-key', $offeringId);
        app(MaintainEnrollment::class)->activate($this->academicOfficer($prefix.'-approver'), Enrollment::query()->findOrFail($requested['enrollment_id']), $prefix.'-activate-key');

        return $requested['enrollment_id'];
    }

    /** @return array{attempt_id: string, result_id: string} */
    private function releasedResult(string $enrollmentId, string $prefix, string $score): array
    {
        $scorer = $this->grantedActor($prefix.'-scorer', ['academic.assess']);
        $moderator = $this->grantedActor($prefix.'-moderator', ['academic.moderate']);
        $approver = $this->grantedActor($prefix.'-approver', ['academic.approve_result']);
        $releaser = $this->grantedActor($prefix.'-releaser', ['academic.release']);

        $attempt = app(ManageAssessmentResult::class)->submitAttempt($scorer, Enrollment::query()->findOrFail($enrollmentId), 'assessment', 'scan/'.$prefix, $prefix.'-attempt');
        $result = app(ManageAssessmentResult::class)->score($scorer, AssessmentAttempt::query()->findOrFail($attempt['attempt_id']), $score, $prefix.'-score');
        /** @var AssessmentResult $row */
        $row = AssessmentResult::query()->findOrFail($result['result_id']);
        app(ManageAssessmentResult::class)->moderate($moderator, $row, $prefix.'-moderate');
        app(ManageAssessmentResult::class)->approve($approver, $row, $prefix.'-approve-result');
        app(ManageAssessmentResult::class)->release($releaser, $row, $prefix.'-release');

        return ['attempt_id' => $attempt['attempt_id'], 'result_id' => $result['result_id']];
    }
}
