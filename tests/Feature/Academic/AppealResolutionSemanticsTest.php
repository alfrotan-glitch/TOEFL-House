<?php

declare(strict_types=1);

namespace Tests\Feature\Academic;

use App\Modules\Academic\Commands\DecideProgression;
use App\Modules\Academic\Commands\MaintainAcademicStructure;
use App\Modules\Academic\Commands\MaintainClass;
use App\Modules\Academic\Commands\MaintainEnrollment;
use App\Modules\Academic\Commands\ManageAcademicAppeal;
use App\Modules\Academic\Commands\ManageAssessmentResult;
use App\Modules\Academic\Models\AcademicAppeal;
use App\Modules\Academic\Models\AcademicPeriod;
use App\Modules\Academic\Models\AssessmentAttempt;
use App\Modules\Academic\Models\AssessmentResult;
use App\Modules\Academic\Models\ClassModel;
use App\Modules\Academic\Models\Enrollment;
use App\Modules\Academic\Models\ProgressionDecision;
use App\Modules\Academic\Models\ResultCorrection;
use App\Modules\Academic\Placement\Commands\DecidePlacement;
use App\Modules\Academic\Placement\Models\PlacementProfile;
use App\Modules\Admissions\Commands\EnrollAdmittedApplicant;
use App\Modules\Admissions\Commands\RegisterApplicant;
use App\Modules\Admissions\Models\Applicant;
use App\Modules\Organization\Models\Branch;
use App\Support\Authorization\Actor;
use App\Support\Errors\AuthorizationDenied;
use App\Support\Errors\BusinessRejection;
use App\Support\Identifiers\RandomIdentifier;
use Carbon\CarbonImmutable;
use Tests\Concerns\BuildsPlacementCatalog;
use Tests\Concerns\DecidesAdmissions;
use Tests\TestCase;

/**
 * Appeal-resolution semantics (WP-ACAD-APPEAL-RESOLVE): filing verifies the
 * subject, `resolved` means upheld AND redressed (verified, never performed),
 * `rejected` leaves the subject standing, and resolve() never mutates the
 * contested record itself.
 */
final class AppealResolutionSemanticsTest extends TestCase
{
    use BuildsPlacementCatalog;
    use DecidesAdmissions;

    private string $branchId;

    private string $classA;

    private string $classB;

    private string $studentId;

    private string $otherStudentId;

    private string $seatId;

    private string $seatBId;

    private string $releasedResultId;

    private string $scoredResultId;

    private string $approvedDecisionId;

    private string $proposedDecisionId;

    private string $releasedProfileId;

    private string $scorerId = 'sem-scorer-1';

    protected function setUp(): void
    {
        parent::setUp();
        $this->setUpPlacementCatalog();
        $structure = app(MaintainAcademicStructure::class);
        $org = $this->grantedActor('sem-org', [
            'academic.structure', 'academic.schedule', 'academic.enroll', 'academic.enroll_approve',
            'academic.progression_propose', 'academic.progression_review', 'academic.progression_approve',
            'academic.appeal_manage',
        ]);

        $this->branchId = Branch::query()->create([
            'id' => RandomIdentifier::new(),
            'name' => 'Appeal Semantics Branch '.substr(md5(RandomIdentifier::new()), 0, 8),
            'lifecycle_state' => 'active',
        ])->id;
        $this->attachBranchToBootstrapOrganization($this->branchId);

        $period = $structure->definePeriod($org, 'Appeal Term', new CarbonImmutable('2026-10-01'), new CarbonImmutable('2026-12-30'), 'sem-period')['period_id'];
        $structure->transitionPeriod($org, AcademicPeriod::query()->findOrFail($period), 'published', 'sem-period-pub');

        // Level-agnostic classes: progression needs no assessment basis here.
        $this->classA = app(MaintainClass::class)->defineClass($org, $this->programVersionId, $period, 8, 'sem-class-a')['class_id'];
        $this->classB = app(MaintainClass::class)->defineClass($org, $this->programVersionId, $period, 8, 'sem-class-b')['class_id'];
        $teacher = $this->personWithAuthority('sem-teacher-1', [])->id;
        foreach (['sem-cls-a', 'sem-cls-b'] as $index => $key) {
            $class = $index === 0 ? $this->classA : $this->classB;
            app(MaintainClass::class)->assignTeacher($org, ClassModel::query()->findOrFail($class), $teacher, new CarbonImmutable('2026-09-01'), null, $key.'-teacher');
            app(MaintainClass::class)->transition($org, ClassModel::query()->findOrFail($class), 'published', $key.'-pub');
            app(MaintainClass::class)->transition($org, ClassModel::query()->findOrFail($class), 'active', $key.'-active');
        }

        $this->studentId = $this->newStudent('sem-student-1');
        $this->otherStudentId = $this->newStudent('sem-student-2');
        $enroll = app(MaintainEnrollment::class);
        $this->seatId = $enroll->request($org, $this->studentId, $this->classA, 'sem-enr-a')['enrollment_id'];
        $enroll->activate($org, Enrollment::query()->findOrFail($this->seatId), 'sem-act-a');
        $this->seatBId = $enroll->request($org, $this->studentId, $this->classB, 'sem-enr-b')['enrollment_id'];
        $enroll->activate($org, Enrollment::query()->findOrFail($this->seatBId), 'sem-act-b');

        $results = app(ManageAssessmentResult::class);
        $scorer = $this->grantedActor($this->scorerId, ['academic.assess']);
        $attempt = $results->submitAttempt($scorer, Enrollment::query()->findOrFail($this->seatId), 'assessment', 'scan/sem-1', 'sem-att-1');
        $released = $results->score($scorer, AssessmentAttempt::query()->findOrFail($attempt['attempt_id']), '87.50', 'sem-score-1');
        $row = AssessmentResult::query()->findOrFail($released['result_id']);
        $results->moderate($this->grantedActor('sem-mod-1', ['academic.moderate']), $row, 'sem-mod-1');
        $results->approve($this->grantedActor('sem-appr-1', ['academic.approve_result']), $row, 'sem-appr-1');
        $results->release($this->grantedActor('sem-rel-1', ['academic.release']), $row, 'sem-rel-1');
        $this->releasedResultId = $row->id;

        $attempt2 = $results->submitAttempt($scorer, Enrollment::query()->findOrFail($this->seatId), 'assessment', 'scan/sem-2', 'sem-att-2');
        $scored = $results->score($scorer, AssessmentAttempt::query()->findOrFail($attempt2['attempt_id']), '70.00', 'sem-score-2');
        $this->scoredResultId = $scored['result_id'];

        $progress = app(DecideProgression::class);
        $proposed = $progress->propose($this->grantedActor('sem-prop-1', ['academic.progression_propose']), $this->studentId, $this->classA, 'advance', 'meets the boundary rules', 'sem-prog-1');
        $decision = ProgressionDecision::query()->findOrFail($proposed['decision_id']);
        $progress->review($this->grantedActor('sem-rev-1', ['academic.progression_review']), $decision, 'sem-prog-2');
        $progress->approve($this->grantedActor('sem-app-1', ['academic.progression_approve']), $decision, 'sem-prog-3');
        $this->approvedDecisionId = $decision->id;

        $proposedB = $progress->propose($this->grantedActor('sem-prop-2', ['academic.progression_propose']), $this->studentId, $this->classB, 'repeat', 'needs another round', 'sem-prog-4');
        $this->proposedDecisionId = $proposedB['decision_id'];

        $this->personWithAuthority('sem-plc-person-1', []);
        $this->releasedProfileId = $this->completeReleasedPlacement('sem-plc-person-1', 'sem-plc')->id;
    }

    private function newStudent(string $personId): string
    {
        $this->personWithAuthority($personId, []);
        $registered = app(RegisterApplicant::class)->register($this->admissionsClerk('sem-clerk-'.$personId), $personId, 'Program', 'sem-reg-'.$personId);
        $applicant = Applicant::query()->findOrFail($registered['applicant_id']);
        $this->runAdmissionDecision(
            $this->admissionsClerk('sem-clerk-'.$personId),
            $this->admissionsReviewer('sem-review-'.$personId),
            $this->admissionsApprover('sem-approve-'.$personId),
            $applicant,
            true,
            'meets policy',
            'ev/sem-'.$personId,
            'sem-adm-'.$personId,
        );

        return app(EnrollAdmittedApplicant::class)->convert($this->admissionsApprover('sem-approve-'.$personId), $applicant, 'sem-conv-'.$personId)['student_id'];
    }

    private function filer(): Actor
    {
        return $this->grantedActor('sem-filer-1', ['academic.appeal_manage']);
    }

    private function reviewer(string $actorId = 'sem-reviewer-1'): Actor
    {
        return $this->grantedActor($actorId, ['academic.appeal_manage']);
    }

    public function test_filing_verifies_subject_existence_appealability_and_student_ownership(): void
    {
        $appeals = app(ManageAcademicAppeal::class);
        $filer = $this->filer();

        try {
            $appeals->file($filer, $this->studentId, 'oral_promise', $this->releasedResultId, 'probe', 'sem-f-x1');
            $this->fail('an unknown subject type must be refused');
        } catch (BusinessRejection $rejection) {
            $this->assertSame('academic.appeal_subject_unknown', $rejection->errorCode());
        }
        try {
            $appeals->file($filer, $this->studentId, 'assessment_result', RandomIdentifier::new(), 'probe', 'sem-f-x2');
            $this->fail('a nonexistent result must be refused');
        } catch (BusinessRejection $rejection) {
            $this->assertSame('academic.appeal_subject_unknown', $rejection->errorCode());
        }
        try {
            $appeals->file($filer, $this->studentId, 'assessment_result', $this->scoredResultId, 'probe', 'sem-f-x3');
            $this->fail('an unreleased result must be refused');
        } catch (BusinessRejection $rejection) {
            $this->assertSame('academic.appeal_subject_not_appealable', $rejection->errorCode());
        }
        try {
            $appeals->file($filer, $this->otherStudentId, 'assessment_result', $this->releasedResultId, 'probe', 'sem-f-x4');
            $this->fail('a subject owned by another student must be refused');
        } catch (BusinessRejection $rejection) {
            $this->assertSame('academic.appeal_subject_student_mismatch', $rejection->errorCode());
        }
        try {
            $appeals->file($filer, $this->studentId, 'progression_decision', $this->proposedDecisionId, 'probe', 'sem-f-x5');
            $this->fail('an undecided progression must be refused');
        } catch (BusinessRejection $rejection) {
            $this->assertSame('academic.appeal_subject_not_appealable', $rejection->errorCode());
        }
        try {
            $appeals->file($filer, '', 'placement_profile', RandomIdentifier::new(), 'probe', 'sem-f-x6');
            $this->fail('a nonexistent placement profile must be refused');
        } catch (BusinessRejection $rejection) {
            $this->assertSame('academic.appeal_placement_unknown', $rejection->errorCode());
        }

        $filed = $appeals->file($filer, $this->studentId, 'assessment_result', $this->releasedResultId, 'section two was mis-marked', 'sem-f-ok');
        $this->assertDatabaseHas('academic_appeals', ['id' => $filed['appeal_id'], 'lifecycle_state' => 'open', 'student_id' => $this->studentId]);
    }

    public function test_assign_fails_fast_on_independence_and_reviewer_scope(): void
    {
        $appeals = app(ManageAcademicAppeal::class);
        $appeal = AcademicAppeal::query()->findOrFail(
            $appeals->file($this->filer(), $this->studentId, 'assessment_result', $this->releasedResultId, 'section two was mis-marked', 'sem-a-file')['appeal_id']
        );

        // The original scorer may not review the appeal.
        try {
            $appeals->assign($this->filer(), $appeal, $this->scorerId, 'sem-a-x1');
            $this->fail('the original scorer must not be assigned the review');
        } catch (AuthorizationDenied $denial) {
            $this->assertSame('academic.appeal_not_independent', $denial->errorCode());
        }

        // A reviewer without the capability cannot be parked on the appeal.
        $this->personWithAuthority('sem-nobody-1', []);
        try {
            $appeals->assign($this->filer(), $appeal, 'sem-nobody-1', 'sem-a-x2');
            $this->fail('a reviewer without appeal authority must be refused');
        } catch (AuthorizationDenied $denial) {
            $this->assertSame('academic.appeal_reviewer_denied', $denial->errorCode());
        }

        $reviewer = $this->reviewer();
        $appeals->assign($this->filer(), $appeal, $reviewer->actorId, 'sem-a-ok');
        $this->assertDatabaseHas('academic_appeals', ['id' => $appeal->id, 'lifecycle_state' => 'assigned', 'assigned_reviewer_id' => 'sem-reviewer-1']);
    }

    public function test_result_appeal_resolves_only_after_remediation_and_never_mutates_the_result(): void
    {
        $appeals = app(ManageAcademicAppeal::class);
        $results = app(ManageAssessmentResult::class);
        $reviewer = $this->reviewer();
        $appeal = AcademicAppeal::query()->findOrFail(
            $appeals->file($this->filer(), $this->studentId, 'assessment_result', $this->releasedResultId, 'section two was mis-marked', 'sem-r-file')['appeal_id']
        );
        $appeals->assign($this->filer(), $appeal, $reviewer->actorId, 'sem-r-assign');
        $appeals->investigate($reviewer, $appeal, 'sem-r-inv');

        try {
            $appeals->resolve($reviewer, $appeal, 'appeal upheld', 'answer-sheet/sem-1', 'sem-r-x1');
            $this->fail('an untouched subject must not resolve');
        } catch (BusinessRejection $rejection) {
            $this->assertSame('academic.appeal_subject_untouched', $rejection->errorCode());
        }

        // Remediation is ordered through the owning result workflow...
        $results->markAppealed($this->grantedActor('sem-marker-1', ['academic.moderate']), AssessmentResult::query()->findOrFail($this->releasedResultId), 'sem-r-mark');

        // ...then the reviewer resolves — and the resolve itself changes
        // nothing on the contested record.
        $appeals->resolve($reviewer, $appeal, 'appeal upheld', 'answer-sheet/sem-1', 'sem-r-ok');
        $this->assertDatabaseHas('academic_appeals', ['id' => $appeal->id, 'lifecycle_state' => 'resolved']);
        $this->assertDatabaseHas('assessment_results', ['id' => $this->releasedResultId, 'lifecycle_state' => 'appealed']);

        // Completing the correction afterwards is the owner's act, and the
        // appeal then closes without further subject effects.
        $correction = $results->proposeCorrection($this->grantedActor('sem-marker-1', ['academic.moderate']), AssessmentResult::query()->findOrFail($this->releasedResultId), '89.00', 'recount verified', 'sem-r-cor');
        $results->approveCorrection($this->grantedActor('sem-cor-appr-1', ['academic.approve_result']), ResultCorrection::query()->findOrFail($correction['correction_id']), 'sem-r-cor-appr');
        $appeals->close($this->grantedActor('sem-closer-1', ['academic.appeal_manage']), $appeal, 'sem-r-close');
        $this->assertDatabaseHas('academic_appeals', ['id' => $appeal->id, 'lifecycle_state' => 'closed', 'outcome' => 'appeal upheld']);
    }

    public function test_rejected_appeal_leaves_the_subject_standing(): void
    {
        $appeals = app(ManageAcademicAppeal::class);
        $reviewer = $this->reviewer('sem-reviewer-2');
        $appeal = AcademicAppeal::query()->findOrFail(
            $appeals->file($this->filer(), $this->studentId, 'assessment_result', $this->releasedResultId, 'section two was mis-marked', 'sem-j-file')['appeal_id']
        );
        $appeals->assign($this->filer(), $appeal, $reviewer->actorId, 'sem-j-assign');
        $appeals->investigate($reviewer, $appeal, 'sem-j-inv');

        // Rejection needs outcome and evidence — but no remediation, because
        // the record standing IS the outcome.
        try {
            $appeals->reject($reviewer, $appeal, '', '', 'sem-j-x1');
            $this->fail('a rejection without outcome evidence must be refused');
        } catch (BusinessRejection $rejection) {
            $this->assertSame('academic.appeal_outcome_required', $rejection->errorCode());
        }
        $appeals->reject($reviewer, $appeal, 'no merit', 'answer-sheet/sem-1 rechecked, marking stands', 'sem-j-ok');
        $this->assertDatabaseHas('academic_appeals', ['id' => $appeal->id, 'lifecycle_state' => 'rejected']);
        $this->assertDatabaseHas('assessment_results', ['id' => $this->releasedResultId, 'lifecycle_state' => 'released']);
    }

    public function test_progression_appeal_resolves_only_after_supersession(): void
    {
        $appeals = app(ManageAcademicAppeal::class);
        $progress = app(DecideProgression::class);
        $reviewer = $this->reviewer('sem-reviewer-3');
        $appeal = AcademicAppeal::query()->findOrFail(
            $appeals->file($this->filer(), $this->studentId, 'progression_decision', $this->approvedDecisionId, 'the repeat call was wrong', 'sem-p-file')['appeal_id']
        );
        $appeals->assign($this->filer(), $appeal, $reviewer->actorId, 'sem-p-assign');
        $appeals->investigate($reviewer, $appeal, 'sem-p-inv');

        try {
            $appeals->resolve($reviewer, $appeal, 'appeal upheld', 'attendance/sem-1', 'sem-p-x1');
            $this->fail('an untouched decision must not resolve');
        } catch (BusinessRejection $rejection) {
            $this->assertSame('academic.appeal_subject_untouched', $rejection->errorCode());
        }

        // Marking appealed alone already records remediation-as-ordered; the
        // full supersession is the owner's heavier path. Either unlocks
        // resolve, and resolve itself supersedes nothing.
        $progress->markAppealed($this->grantedActor('sem-p-marker-1', ['academic.progression_review']), ProgressionDecision::query()->findOrFail($this->approvedDecisionId), 'sem-p-mark');
        $appeals->resolve($reviewer, $appeal, 'appeal upheld', 'attendance/sem-1', 'sem-p-ok');
        $this->assertDatabaseHas('academic_appeals', ['id' => $appeal->id, 'lifecycle_state' => 'resolved']);
        $this->assertDatabaseHas('progression_decisions', ['id' => $this->approvedDecisionId, 'lifecycle_state' => 'appealed']);
    }

    public function test_placement_appeal_resolves_only_after_the_profile_leaves_the_open_set(): void
    {
        $appeals = app(ManageAcademicAppeal::class);
        $reviewer = $this->reviewer('sem-reviewer-4');
        $appeal = AcademicAppeal::query()->findOrFail(
            $appeals->file($this->filer(), '', 'placement_profile', $this->releasedProfileId, 'the speaking band looks wrong', 'sem-pl-file')['appeal_id']
        );
        $appeals->assign($this->filer(), $appeal, $reviewer->actorId, 'sem-pl-assign');
        $appeals->investigate($reviewer, $appeal, 'sem-pl-inv');

        try {
            $appeals->resolve($reviewer, $appeal, 'appeal upheld', 'recording/sem-pl-1', 'sem-pl-x1');
            $this->fail('a still-open profile must not resolve');
        } catch (BusinessRejection $rejection) {
            $this->assertSame('academic.appeal_subject_untouched', $rejection->errorCode());
        }

        // Placement has no appealed state: the retake path (supersede)
        // records the remediation through the owning placement workflow.
        app(DecidePlacement::class)->supersede($this->placementReleaser('sem-pl-rel-1'), PlacementProfile::query()->findOrFail($this->releasedProfileId), 'sem-pl-sup');
        $appeals->resolve($reviewer, $appeal, 'appeal upheld', 'recording/sem-pl-1', 'sem-pl-ok');
        $this->assertDatabaseHas('academic_appeals', ['id' => $appeal->id, 'lifecycle_state' => 'resolved']);
        $this->assertDatabaseHas('placement_profiles', ['id' => $this->releasedProfileId, 'lifecycle_state' => 'superseded']);
    }
}
