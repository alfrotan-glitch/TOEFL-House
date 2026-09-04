<?php

declare(strict_types=1);

namespace Tests\Feature\Academic;

use App\Modules\Academic\Commands\DecideProgression;
use App\Modules\Academic\Commands\MaintainAcademicStructure;
use App\Modules\Academic\Commands\MaintainClass;
use App\Modules\Academic\Commands\MaintainEnrollment;
use App\Modules\Academic\Commands\ManageAssessmentResult;
use App\Modules\Academic\Models\AcademicPeriod;
use App\Modules\Academic\Models\AssessmentAttempt;
use App\Modules\Academic\Models\AssessmentResult;
use App\Modules\Academic\Models\ClassModel;
use App\Modules\Academic\Models\Enrollment;
use App\Modules\Academic\Models\Program;
use App\Modules\Academic\Models\ProgressionDecision;
use App\Modules\Audit\Models\AuditEvent as AuditEventModel;
use App\Modules\Finance\Commands\AllocatePayment;
use App\Modules\Finance\Commands\PostObligation;
use App\Modules\Finance\Commands\RecordPayment;
use App\Modules\Finance\Models\FinancialPeriod;
use App\Modules\Finance\Models\Obligation;
use App\Modules\Finance\Models\Payment;
use App\Modules\Identity\Models\UserAccount;
use App\Support\Errors\AuthorizationDenied;
use App\Support\Errors\BusinessRejection;
use App\Support\Errors\DomainError;
use App\Support\Identifiers\RandomIdentifier;
use Carbon\CarbonImmutable;
use Illuminate\Support\Facades\Hash;
use Tests\Concerns\BuildsStudents;
use Tests\TestCase;

/**
 * AC5 enrollment completion lifecycle: reasoned freeze, unfreeze with a
 * financial re-gate, reasoned withdraw, and evidenced completion — all with
 * Finance-read exit snapshots and end-to-end console transport. Finance
 * stays the sole financial authority: Academic writes no Finance facts.
 */
final class EnrollmentCompletionLifecycleFeatureTest extends TestCase
{
    use BuildsStudents;

    private string $programVersionId;

    private string $periodId;

    private string $levelId;

    private string $levelClassId;

    private string $smallClassId;

    private string $legacyClassId;

    protected function setUp(): void
    {
        parent::setUp();
        $this->personWithAuthority('comp-teacher-1', []);
        $structure = app(MaintainAcademicStructure::class);
        $officer = $this->academicOfficer('comp-officer');

        $program = $structure->defineProgram($officer, 'Completion Program', 'comp-prog');
        $this->programVersionId = (string) $structure->publishVersion($officer, Program::query()->findOrFail($program['program_id']), 'Completion v1', 'comp-ver')['version_id'];
        $this->levelId = (string) $structure->defineLevel($officer, $this->programVersionId, 'L1', 1, 'Level One', 'A1', 'comp-lvl')['level_id'];
        $this->periodId = (string) $structure->definePeriod($officer, 'Completion Term', new CarbonImmutable('2026-09-01'), new CarbonImmutable('2026-12-31'), 'comp-period')['period_id'];
        $structure->transitionPeriod($officer, AcademicPeriod::query()->findOrFail($this->periodId), 'published', 'comp-period-pub');

        $this->levelClassId = $this->defineActiveClass('comp-class', 2, $this->levelId);
        $this->smallClassId = $this->defineActiveClass('comp-small', 1, $this->levelId);
        $this->legacyClassId = $this->defineActiveClass('comp-legacy', 5, null);
    }

    public function test_freeze_requires_reason_and_records_it(): void
    {
        $seatId = $this->activeSeat('reason', $this->levelClassId);
        $officer = $this->academicOfficer('comp-officer-freeze');

        try {
            app(MaintainEnrollment::class)->freeze($officer, Enrollment::query()->findOrFail($seatId), '', 'comp-freeze-empty');
            $this->fail('a freeze without a reason must be rejected');
        } catch (BusinessRejection $rejection) {
            $this->assertSame('academic.enrollment_reason_required', $rejection->errorCode());
        }

        $frozen = app(MaintainEnrollment::class)->freeze($officer, Enrollment::query()->findOrFail($seatId), 'medical leave verified by clinic note', 'comp-freeze-1');
        $this->assertSame('frozen', $frozen['lifecycle_state']);
        $this->assertDatabaseHas('enrollments', [
            'id' => $seatId,
            'lifecycle_state' => 'frozen',
            'state_reason' => 'medical leave verified by clinic note',
        ]);

        /** @var AuditEventModel $event */
        $event = AuditEventModel::query()
            ->where('operation', 'academic.enrollment.frozen')
            ->where('target_id', $seatId)
            ->firstOrFail();
        $this->assertSame('medical leave verified by clinic note', $event->after_state['state_reason']);
        $this->assertTrue((bool) $event->after_state['finance_gate_exit']['satisfied']);
        $this->assertSame('0.00', $event->after_state['finance_gate_exit']['remaining']);
    }

    public function test_freeze_requires_the_approve_capability(): void
    {
        $seatId = $this->activeSeat('sod', $this->levelClassId);

        try {
            app(MaintainEnrollment::class)->freeze($this->enrollmentClerk('comp-clerk-freeze'), Enrollment::query()->findOrFail($seatId), 'clerk freeze attempt', 'comp-freeze-sod');
            $this->fail('a clerk without the approve capability cannot freeze');
        } catch (AuthorizationDenied $denial) {
            $this->assertSame('academic.enrollment_denied', $denial->errorCode());
        }
        $this->assertSame('active', Enrollment::query()->findOrFail($seatId)->lifecycle_state);
    }

    public function test_frozen_seat_frees_capacity_and_unfreeze_rechecks_it(): void
    {
        $officer = $this->academicOfficer('comp-officer-cap');
        $seatA = $this->activeSeat('cap-a', $this->smallClassId);

        app(MaintainEnrollment::class)->freeze($officer, Enrollment::query()->findOrFail($seatA), 'term break', 'comp-cap-freeze');

        // The frozen seat holds no capacity claim: a second student activates.
        $seatB = $this->activeSeat('cap-b', $this->smallClassId);
        $this->assertSame('active', Enrollment::query()->findOrFail($seatB)->lifecycle_state);

        try {
            app(MaintainEnrollment::class)->unfreeze($officer, Enrollment::query()->findOrFail($seatA), 'comp-cap-unfreeze');
            $this->fail('an unfreeze into a full class must be refused');
        } catch (BusinessRejection $rejection) {
            $this->assertSame('academic.class_full', $rejection->errorCode());
        }
        $this->assertSame('frozen', Enrollment::query()->findOrFail($seatA)->lifecycle_state);
    }

    public function test_unfreeze_regates_finance(): void
    {
        $officer = $this->academicOfficer('comp-officer-gate');
        $seatId = $this->activeSeat('gate', $this->levelClassId);
        app(MaintainEnrollment::class)->freeze($officer, Enrollment::query()->findOrFail($seatId), 'payment plan review', 'comp-gate-freeze');

        $studentId = (string) Enrollment::query()->findOrFail($seatId)->student_id;
        $period = $this->openPeriod('gate');
        $obligation = $this->postTuitionObligation('gate', $period, $studentId);

        try {
            app(MaintainEnrollment::class)->unfreeze($officer, Enrollment::query()->findOrFail($seatId), 'comp-gate-unfreeze-deny');
            $this->fail('an unpaid return must refuse the unfreeze');
        } catch (DomainError $rejection) {
            $this->assertSame('academic.enrollment.financial_gate', $rejection->errorCode());
        }
        $this->assertSame('frozen', Enrollment::query()->findOrFail($seatId)->lifecycle_state);
        $this->assertDatabaseHas('audit_events', [
            'operation' => 'academic.enrollment.financial_gate.denied',
            'target_type' => 'enrollment',
            'target_id' => $seatId,
        ]);

        $financier = $this->grantedActor('comp-gate-financier', ['finance.payment']);
        $recorded = app(RecordPayment::class)->record($financier, $period, $studentId, '1000.00', 'bank', 'comp-gate-payer', '2026-09-02', 'comp-gate-payment');
        app(AllocatePayment::class)->allocate($financier, Payment::query()->findOrFail($recorded['payment_id']), $obligation, '1000.00', 'comp-gate-allocation');

        $returned = app(MaintainEnrollment::class)->unfreeze($officer, Enrollment::query()->findOrFail($seatId), 'comp-gate-unfreeze-ok');
        $this->assertSame('active', $returned['lifecycle_state']);

        $enrollment = Enrollment::query()->findOrFail($seatId);
        $this->assertNull($enrollment->state_reason);
        $this->assertTrue((bool) $enrollment->financial_gate_satisfied);
        $this->assertSame('0.00', $enrollment->financial_gate_evidence['remaining']);
    }

    public function test_unfreeze_requires_a_frozen_seat(): void
    {
        $seatId = $this->activeSeat('state', $this->levelClassId);

        try {
            app(MaintainEnrollment::class)->unfreeze($this->academicOfficer('comp-officer-state'), Enrollment::query()->findOrFail($seatId), 'comp-unfreeze-state');
            $this->fail('an active seat cannot be unfrozen');
        } catch (BusinessRejection $rejection) {
            $this->assertSame('academic.enrollment_transition_forbidden', $rejection->errorCode());
        }
    }

    public function test_withdraw_requires_reason_is_terminal_and_carries_exit_snapshot(): void
    {
        $seatId = $this->activeSeat('withdraw', $this->levelClassId);
        $clerk = $this->enrollmentClerk('comp-clerk-withdraw');

        try {
            app(MaintainEnrollment::class)->withdraw($clerk, Enrollment::query()->findOrFail($seatId), '', 'comp-withdraw-empty');
            $this->fail('a withdraw without a reason must be rejected');
        } catch (BusinessRejection $rejection) {
            $this->assertSame('academic.enrollment_reason_required', $rejection->errorCode());
        }

        $withdrawn = app(MaintainEnrollment::class)->withdraw($clerk, Enrollment::query()->findOrFail($seatId), 'family relocation verified', 'comp-withdraw-1');
        $this->assertSame('withdrawn', $withdrawn['lifecycle_state']);
        $this->assertDatabaseHas('enrollments', [
            'id' => $seatId,
            'lifecycle_state' => 'withdrawn',
            'state_reason' => 'family relocation verified',
        ]);

        /** @var AuditEventModel $event */
        $event = AuditEventModel::query()
            ->where('operation', 'academic.enrollment.withdrawn')
            ->where('target_id', $seatId)
            ->firstOrFail();
        $this->assertSame('family relocation verified', $event->after_state['state_reason']);
        $this->assertArrayHasKey('finance_gate_exit', $event->after_state);

        try {
            app(MaintainEnrollment::class)->freeze($this->academicOfficer('comp-officer-wd'), Enrollment::query()->findOrFail($seatId), 'too late', 'comp-withdraw-frozen');
            $this->fail('a withdrawn seat must accept no further transition');
        } catch (BusinessRejection $rejection) {
            $this->assertSame('academic.enrollment_transition_forbidden', $rejection->errorCode());
        }
    }

    public function test_complete_requires_basis(): void
    {
        $seatId = $this->activeSeat('basis', $this->levelClassId);

        try {
            app(MaintainEnrollment::class)->complete($this->academicOfficer('comp-officer-basis'), Enrollment::query()->findOrFail($seatId), '', null, null, 'comp-complete-empty');
            $this->fail('a completion without a basis must be rejected');
        } catch (BusinessRejection $rejection) {
            $this->assertSame('academic.enrollment_completion_basis_required', $rejection->errorCode());
        }
    }

    public function test_complete_on_level_class_requires_evidence(): void
    {
        $seatId = $this->activeSeat('evreq', $this->levelClassId);

        try {
            app(MaintainEnrollment::class)->complete($this->academicOfficer('comp-officer-evreq'), Enrollment::query()->findOrFail($seatId), 'finished the term', null, null, 'comp-complete-noev');
            $this->fail('a level seat must not complete on a bare basis');
        } catch (BusinessRejection $rejection) {
            $this->assertSame('academic.enrollment_completion_evidence_required', $rejection->errorCode());
        }
        $this->assertSame('active', Enrollment::query()->findOrFail($seatId)->lifecycle_state);
    }

    public function test_complete_with_released_result_pins_evidence(): void
    {
        $seatId = $this->activeSeat('result', $this->levelClassId);
        $released = $this->releasedResult($seatId, 'comp-result', '82.00');

        $completed = app(MaintainEnrollment::class)->complete(
            $this->academicOfficer('comp-officer-result'),
            Enrollment::query()->findOrFail($seatId),
            'completed all L1 requirements',
            'assessment_result',
            $released['result_id'],
            'comp-complete-result',
        );
        $this->assertSame('completed', $completed['lifecycle_state']);
        $this->assertDatabaseHas('enrollments', [
            'id' => $seatId,
            'lifecycle_state' => 'completed',
            'completion_basis' => 'completed all L1 requirements',
            'completion_evidence_kind' => 'assessment_result',
            'completion_evidence_id' => $released['result_id'],
        ]);

        /** @var AuditEventModel $event */
        $event = AuditEventModel::query()
            ->where('operation', 'academic.enrollment.completed')
            ->where('target_id', $seatId)
            ->firstOrFail();
        $this->assertSame('completed all L1 requirements', $event->after_state['completion_basis']);
        $this->assertSame('assessment_result', $event->after_state['completion_evidence_kind']);
        $this->assertArrayHasKey('finance_gate_exit', $event->after_state);
    }

    public function test_complete_with_approved_progression_pins_evidence(): void
    {
        $seatId = $this->activeSeat('prog', $this->levelClassId);
        $studentId = (string) Enrollment::query()->findOrFail($seatId)->student_id;
        $decisionId = $this->approvedRepeat($studentId, $this->levelClassId, 'comp-prog');

        $completed = app(MaintainEnrollment::class)->complete(
            $this->academicOfficer('comp-officer-prog'),
            Enrollment::query()->findOrFail($seatId),
            'completed term with a repeat outcome',
            'progression_decision',
            $decisionId,
            'comp-complete-prog',
        );
        $this->assertSame('completed', $completed['lifecycle_state']);
        $this->assertDatabaseHas('enrollments', [
            'id' => $seatId,
            'completion_evidence_kind' => 'progression_decision',
            'completion_evidence_id' => $decisionId,
        ]);
    }

    public function test_complete_rejects_foreign_and_unknown_evidence(): void
    {
        $seatA = $this->activeSeat('foreign-a', $this->levelClassId);
        $seatB = $this->activeSeat('foreign-b', $this->levelClassId);
        $released = $this->releasedResult($seatB, 'comp-foreign', '77.00');
        $officer = $this->academicOfficer('comp-officer-foreign');

        try {
            app(MaintainEnrollment::class)->complete($officer, Enrollment::query()->findOrFail($seatA), 'basis', 'assessment_result', $released['result_id'], 'comp-complete-foreign');
            $this->fail('evidence from another seat must be refused');
        } catch (BusinessRejection $rejection) {
            $this->assertSame('academic.enrollment_completion_evidence_mismatch', $rejection->errorCode());
        }

        try {
            app(MaintainEnrollment::class)->complete($officer, Enrollment::query()->findOrFail($seatA), 'basis', 'certificate', RandomIdentifier::new(), 'comp-complete-kind');
            $this->fail('an unknown evidence kind must be refused');
        } catch (BusinessRejection $rejection) {
            $this->assertSame('academic.enrollment_completion_evidence_unknown', $rejection->errorCode());
        }

        try {
            app(MaintainEnrollment::class)->complete($officer, Enrollment::query()->findOrFail($seatA), 'basis', 'assessment_result', RandomIdentifier::new(), 'comp-complete-missing');
            $this->fail('a missing result must be refused');
        } catch (BusinessRejection $rejection) {
            $this->assertSame('academic.enrollment_completion_evidence_mismatch', $rejection->errorCode());
        }
        $this->assertSame('active', Enrollment::query()->findOrFail($seatA)->lifecycle_state);
    }

    public function test_complete_on_legacy_class_with_basis_only(): void
    {
        $seatId = $this->activeSeat('legacy', $this->legacyClassId);

        $completed = app(MaintainEnrollment::class)->complete(
            $this->academicOfficer('comp-officer-legacy'),
            Enrollment::query()->findOrFail($seatId),
            'finished the legacy curriculum',
            null,
            null,
            'comp-complete-legacy',
        );
        $this->assertSame('completed', $completed['lifecycle_state']);

        $enrollment = Enrollment::query()->findOrFail($seatId);
        $this->assertSame('finished the legacy curriculum', $enrollment->completion_basis);
        $this->assertNull($enrollment->completion_evidence_kind);
        $this->assertNull($enrollment->completion_evidence_id);
    }

    public function test_completion_lifecycle_over_http(): void
    {
        $officer = $this->personWithAuthority('comp-web-officer', ['academic.enroll', 'academic.enroll_approve']);
        $this->signInAs($officer->id, 'comp.web');

        $seatId = $this->activeSeat('web', $this->legacyClassId);

        $this->post("/academic/enrollments/{$seatId}/freeze", ['reason' => 'web verified leave'])
            ->assertRedirect();
        $this->assertSame('frozen', Enrollment::query()->findOrFail($seatId)->lifecycle_state);

        $this->post("/academic/enrollments/{$seatId}/unfreeze")
            ->assertRedirect();
        $this->assertSame('active', Enrollment::query()->findOrFail($seatId)->lifecycle_state);

        $this->post("/academic/enrollments/{$seatId}/complete", ['basis' => 'web verified completion'])
            ->assertRedirect();
        $this->assertSame('completed', Enrollment::query()->findOrFail($seatId)->lifecycle_state);

        $nobody = $this->personWithAuthority('comp-web-nobody', []);
        $this->signInAs($nobody->id, 'comp.nobody');
        $seatOther = $this->activeSeat('web-denied', $this->legacyClassId);
        $this->post("/academic/enrollments/{$seatOther}/freeze", ['reason' => 'no authority'])
            ->assertRedirect()
            ->assertSessionHas('error_code', 'academic.enrollment_denied');
        $this->assertSame('active', Enrollment::query()->findOrFail($seatOther)->lifecycle_state);
    }

    private function signInAs(string $personId, string $username): void
    {
        UserAccount::query()->create([
            'id' => RandomIdentifier::new(),
            'person_id' => $personId,
            'username' => $username,
            'password_hash' => Hash::make('completion-pw-1'),
            'account_state' => UserAccount::STATE_ACTIVE,
        ]);
        $this->post('/login', ['username' => $username, 'password' => 'completion-pw-1'])->assertRedirect('/');
    }

    private function defineActiveClass(string $key, int $capacity, ?string $levelId): string
    {
        $officer = $this->academicOfficer('comp-officer-define');
        $classId = (string) app(MaintainClass::class)->defineClass($officer, $this->programVersionId, $this->periodId, $capacity, $key, $levelId)['class_id'];
        app(MaintainClass::class)->assignTeacher($officer, ClassModel::query()->findOrFail($classId), 'comp-teacher-1', new CarbonImmutable('2026-09-01'), null, $key.'-teacher');
        app(MaintainClass::class)->transition($officer, ClassModel::query()->findOrFail($classId), 'published', $key.'-pub');
        app(MaintainClass::class)->transition($officer, ClassModel::query()->findOrFail($classId), 'active', $key.'-active');

        return $classId;
    }

    private function activeSeat(string $seed, string $classId): string
    {
        $studentId = (string) $this->makeStudent([
            'initiator' => 'comp-adm-init-'.$seed,
            'reviewer' => 'comp-adm-review-'.$seed,
            'approver' => 'comp-adm-approve-'.$seed,
        ])['student']->id;

        $requested = app(MaintainEnrollment::class)->request($this->enrollmentClerk('comp-clerk-'.$seed), $studentId, $classId, 'comp-enroll-'.$seed);
        app(MaintainEnrollment::class)->activate($this->academicOfficer('comp-approver-'.$seed), Enrollment::query()->findOrFail($requested['enrollment_id']), 'comp-activate-'.$seed);

        return $requested['enrollment_id'];
    }

    private function openPeriod(string $seed): FinancialPeriod
    {
        return FinancialPeriod::query()->create([
            'id' => RandomIdentifier::new(),
            'period_key' => 'comp-'.$seed.'-'.substr(md5(RandomIdentifier::new()), 0, 8),
            'date_from' => '2026-09-01',
            'date_to' => '2026-12-31',
            'lifecycle_state' => 'open',
        ]);
    }

    private function postTuitionObligation(string $seed, FinancialPeriod $period, string $studentId): Obligation
    {
        $poster = $this->grantedActor('comp-obligation-'.$seed, ['finance.obligation']);
        $post = app(PostObligation::class)->post($poster, $period, $studentId, 'admissions/tuition', 'Completion tuition', [
            ['category' => 'tuition', 'amount' => '1000.00', 'source_ref' => 'comp-tuition-'.$seed],
        ], 'comp-obligation-'.$seed);

        return Obligation::query()->findOrFail($post['obligation_id']);
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

    private function approvedRepeat(string $studentId, string $classId, string $prefix): string
    {
        $decision = app(DecideProgression::class)->propose(
            $this->grantedActor($prefix.'-proposer', ['academic.progression_propose']),
            $studentId,
            $classId,
            'repeat',
            'needs one more term',
            $prefix.'-propose',
            null,
            'remediation evidence',
        );
        $decisionId = $decision['decision_id'];
        app(DecideProgression::class)->review($this->grantedActor($prefix.'-reviewer', ['academic.progression_review']), ProgressionDecision::query()->findOrFail($decisionId), $prefix.'-review');
        app(DecideProgression::class)->approve($this->grantedActor($prefix.'-approver', ['academic.progression_approve']), ProgressionDecision::query()->findOrFail($decisionId), $prefix.'-approve');

        return $decisionId;
    }
}
