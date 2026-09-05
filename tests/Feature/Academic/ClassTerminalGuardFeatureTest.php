<?php

declare(strict_types=1);

namespace Tests\Feature\Academic;

use App\Modules\Academic\Commands\DecideGraduation;
use App\Modules\Academic\Commands\DecideProgression;
use App\Modules\Academic\Commands\MaintainAcademicStructure;
use App\Modules\Academic\Commands\MaintainClass;
use App\Modules\Academic\Commands\MaintainEnrollment;
use App\Modules\Academic\Commands\ManageAssessmentResult;
use App\Modules\Academic\Commands\RecordAttendance;
use App\Modules\Academic\Models\AcademicPeriod;
use App\Modules\Academic\Models\AssessmentAttempt;
use App\Modules\Academic\Models\AssessmentResult;
use App\Modules\Academic\Models\ClassModel;
use App\Modules\Academic\Models\ClassSession;
use App\Modules\Academic\Models\Enrollment;
use App\Modules\Academic\Models\GraduationDecision;
use App\Modules\Academic\Models\Program;
use App\Modules\Academic\Models\ProgressionDecision;
use App\Modules\Audit\Models\AuditEvent as AuditEventModel;
use App\Modules\Identity\Models\UserAccount;
use App\Support\Errors\BusinessRejection;
use App\Support\Identifiers\RandomIdentifier;
use Carbon\CarbonImmutable;
use Illuminate\Support\Facades\Hash;
use Tests\Concerns\BuildsStudents;
use Tests\TestCase;

/**
 * Blocker 2 (audit): class → cancelled/completed and period → closed were
 * state-machine checks only, so live delivery could be stranded on a dead
 * class or in a closed term. These tests pin the fail-closed doctrine
 * (WP-ACAD-TERMINAL-GUARD): terminal moves refuse while requested, active,
 * or frozen seats are outstanding — mirroring the ratified offering
 * (academic.offering_open_seats) and graduation
 * (academic.graduation_open_seats) gates — and prove the legal terminal
 * arc preserves assessment, attendance history, progression, graduation,
 * audit history, and irreversibility on every transport.
 */
final class ClassTerminalGuardFeatureTest extends TestCase
{
    use BuildsStudents;

    /** @return array{version_id: string, period_id: string, class_id: string} */
    private function freshActiveClass(string $seed): array
    {
        $officer = $this->academicOfficer('term-officer-'.$seed);
        $this->personWithAuthority('term-teacher-'.$seed, []);
        $structure = app(MaintainAcademicStructure::class);

        $program = $structure->defineProgram($officer, 'Terminal Guard Program '.$seed, 'term-prog-'.$seed);
        $version = $structure->publishVersion($officer, Program::query()->findOrFail($program['program_id']), 'rules', 'term-ver-'.$seed);
        $period = $structure->definePeriod($officer, 'Terminal Term '.$seed, new CarbonImmutable('2026-09-01'), new CarbonImmutable('2026-12-18'), 'term-per-'.$seed);
        $structure->transitionPeriod($officer, AcademicPeriod::query()->findOrFail($period['period_id']), 'published', 'term-per-pub-'.$seed);

        $class = app(MaintainClass::class)->defineClass($officer, $version['version_id'], $period['period_id'], 4, 'term-class-'.$seed);
        app(MaintainClass::class)->assignTeacher($officer, ClassModel::query()->findOrFail($class['class_id']), 'term-teacher-'.$seed, new CarbonImmutable('2026-09-01'), null, 'term-teach-'.$seed);
        app(MaintainClass::class)->transition($officer, ClassModel::query()->findOrFail($class['class_id']), 'published', 'term-pub-'.$seed);
        app(MaintainClass::class)->transition($officer, ClassModel::query()->findOrFail($class['class_id']), 'active', 'term-act-'.$seed);

        return ['version_id' => $version['version_id'], 'period_id' => $period['period_id'], 'class_id' => $class['class_id']];
    }

    private function activeSeat(string $seed, string $classId): string
    {
        $studentId = (string) $this->makeStudent([
            'initiator' => 'term-adm-init-'.$seed,
            'reviewer' => 'term-adm-review-'.$seed,
            'approver' => 'term-adm-approve-'.$seed,
        ])['student']->id;

        $requested = app(MaintainEnrollment::class)->request($this->enrollmentClerk('term-clerk-'.$seed), $studentId, $classId, 'term-enroll-'.$seed);
        app(MaintainEnrollment::class)->activate($this->academicOfficer('term-approver-'.$seed), Enrollment::query()->findOrFail($requested['enrollment_id']), 'term-activate-'.$seed);

        return $requested['enrollment_id'];
    }

    /** @return array{attempt_id: string, result_id: string} */
    private function releasedResult(string $seatId, string $prefix, string $score): array
    {
        $scorer = $this->grantedActor($prefix.'-scorer', ['academic.assess']);
        $moderator = $this->grantedActor($prefix.'-moderator', ['academic.moderate']);
        $approver = $this->grantedActor($prefix.'-approver', ['academic.approve_result']);
        $releaser = $this->grantedActor($prefix.'-releaser', ['academic.release']);

        $attempt = app(ManageAssessmentResult::class)->submitAttempt($scorer, Enrollment::query()->findOrFail($seatId), 'assessment', 'scan/'.$prefix, $prefix.'-attempt');
        $result = app(ManageAssessmentResult::class)->score($scorer, AssessmentAttempt::query()->findOrFail($attempt['attempt_id']), $score, $prefix.'-score');
        /** @var AssessmentResult $row */
        $row = AssessmentResult::query()->findOrFail($result['result_id']);
        app(ManageAssessmentResult::class)->moderate($moderator, $row, $prefix.'-moderate');
        app(ManageAssessmentResult::class)->approve($approver, $row, $prefix.'-approve-result');
        app(ManageAssessmentResult::class)->release($releaser, $row, $prefix.'-release');

        return ['attempt_id' => $attempt['attempt_id'], 'result_id' => $result['result_id']];
    }

    private function signInOfficer(string $seed): void
    {
        $officer = $this->academicOfficer('term-webofficer-'.$seed);
        UserAccount::query()->create([
            'id' => RandomIdentifier::new(),
            'person_id' => $officer->actorId,
            'username' => 'term.webofficer.'.$seed,
            'password_hash' => Hash::make('term-web-pw-1'),
            'account_state' => UserAccount::STATE_ACTIVE,
        ]);
        $this->post('/login', ['username' => 'term.webofficer.'.$seed, 'password' => 'term-web-pw-1'])->assertRedirect('/');
    }

    public function test_terminal_class_moves_refuse_every_live_seat_state(): void
    {
        foreach (['requested' => 'req', 'active' => 'act', 'frozen' => 'frz'] as $seatState => $seatCode) {
            foreach (['cancelled' => 'can', 'completed' => 'cmp'] as $target => $targetCode) {
                $seed = $seatCode.'-'.$targetCode;
                ['class_id' => $classId] = $this->freshActiveClass($seed);
                $seatId = $this->activeSeat($seed, $classId);
                $officer = $this->academicOfficer('term-guard-'.$seed);

                if ($seatState === 'requested') {
                    // activeSeat activates; rebuild a requested-only seat.
                    $requestedOnly = app(MaintainEnrollment::class)->request(
                        $this->enrollmentClerk('term-clerk-ro-'.$seed),
                        (string) $this->makeStudent([
                            'initiator' => 'term-adm-init-ro-'.$seed,
                            'reviewer' => 'term-adm-review-ro-'.$seed,
                            'approver' => 'term-adm-approve-ro-'.$seed,
                        ])['student']->id,
                        $classId,
                        'term-enroll-ro-'.$seed,
                    )['enrollment_id'];
                    app(MaintainEnrollment::class)->withdraw($this->enrollmentClerk('term-clerk-wd-'.$seed), Enrollment::query()->findOrFail($seatId), 'duplicate request consolidated', 'term-wd-active-'.$seed);
                    $seatId = $requestedOnly;
                } elseif ($seatState === 'frozen') {
                    app(MaintainEnrollment::class)->freeze($officer, Enrollment::query()->findOrFail($seatId), 'student requested a term break', 'term-freeze-'.$seed);
                }

                try {
                    app(MaintainClass::class)->transition($officer, ClassModel::query()->findOrFail($classId), $target, 'term-guard-'.$seed);
                    $this->fail("class with a {$seatState} seat must not move to {$target}");
                } catch (BusinessRejection $rejection) {
                    $this->assertSame('academic.class_open_seats', $rejection->errorCode());
                }
                $this->assertSame('active', ClassModel::query()->findOrFail($classId)->lifecycle_state);
                $this->assertSame($seatState, Enrollment::query()->findOrFail($seatId)->lifecycle_state);
            }
        }
    }

    public function test_cancel_succeeds_once_every_seat_is_terminal(): void
    {
        ['class_id' => $classId] = $this->freshActiveClass('cancel-arc');
        $officer = $this->academicOfficer('term-cancel-arc');
        $withdrawn = $this->activeSeat('cancel-wd', $classId);
        $transferred = $this->activeSeat('cancel-tr', $classId);
        ['class_id' => $targetId] = $this->freshActiveClass('cancel-target');

        app(MaintainEnrollment::class)->withdraw($this->enrollmentClerk('term-cancel-clerk'), Enrollment::query()->findOrFail($withdrawn), 'family relocation verified', 'term-cancel-wd');
        app(MaintainEnrollment::class)->transfer($officer, Enrollment::query()->findOrFail($transferred), $targetId, 'term-cancel-tr');

        $cancelled = app(MaintainClass::class)->transition($officer, ClassModel::query()->findOrFail($classId), 'cancelled', 'term-cancel-ok');
        $this->assertSame('cancelled', $cancelled['lifecycle_state']);
        $this->assertDatabaseHas('audit_events', ['operation' => 'academic.class.transition', 'target_type' => 'class', 'target_id' => $classId]);

        $archived = app(MaintainClass::class)->transition($officer, ClassModel::query()->findOrFail($classId), 'archived', 'term-cancel-arch');
        $this->assertSame('archived', $archived['lifecycle_state']);
    }

    public function test_completed_class_preserves_assessment_progression_and_graduation(): void
    {
        ['version_id' => $versionId, 'class_id' => $classId] = $this->freshActiveClass('full-arc');
        $officer = $this->academicOfficer('term-full-arc');

        $evidenced = $this->activeSeat('full-ev', $classId);
        $released = $this->releasedResult($evidenced, 'term-full', '82.00');
        app(MaintainEnrollment::class)->complete($officer, Enrollment::query()->findOrFail($evidenced), 'completed all requirements', 'assessment_result', $released['result_id'], 'term-full-complete-ev');

        $plain = $this->activeSeat('full-plain', $classId);
        app(MaintainEnrollment::class)->complete($officer, Enrollment::query()->findOrFail($plain), 'finished the term', null, null, 'term-full-complete-plain');

        $completed = app(MaintainClass::class)->transition($officer, ClassModel::query()->findOrFail($classId), 'completed', 'term-full-complete-class');
        $this->assertSame('completed', $completed['lifecycle_state']);

        // Progression still decides on the completed class (legacy class:
        // outcome with no level fields).
        $studentId = (string) Enrollment::query()->findOrFail($evidenced)->student_id;
        $decision = app(DecideProgression::class)->propose(
            $this->grantedActor('term-full-prop', ['academic.progression_propose']),
            $studentId, $classId, 'repeat', 'needs one more term', 'term-full-propose',
        );
        app(DecideProgression::class)->review(
            $this->grantedActor('term-full-rev', ['academic.progression_review']),
            ProgressionDecision::query()->findOrFail($decision['decision_id']), 'term-full-review',
        );
        $approved = app(DecideProgression::class)->approve(
            $this->grantedActor('term-full-appr', ['academic.progression_approve']),
            ProgressionDecision::query()->findOrFail($decision['decision_id']), 'term-full-approve',
        );
        $this->assertSame('approved', $approved['lifecycle_state']);

        // Graduation still approves: the seats are terminal, the class being
        // completed does not strand the decision.
        $grad = app(DecideGraduation::class)->propose(
            $this->grantedActor('term-full-gprop', ['academic.completion']),
            $studentId, $versionId, 'eligible', 'program requirements verified', 'term-full-gpropose',
        );
        app(DecideGraduation::class)->review(
            $this->grantedActor('term-full-grev', ['academic.completion']),
            GraduationDecision::query()->findOrFail($grad['decision_id']), 'term-full-greview',
        );
        $gradApproved = app(DecideGraduation::class)->approve(
            $this->grantedActor('term-full-gapp', ['academic.completion_approve']),
            GraduationDecision::query()->findOrFail($grad['decision_id']), 'term-full-gapprove',
        );
        $this->assertSame('approved', $gradApproved['lifecycle_state']);

        // History: every governed step left its audit trail.
        foreach (['academic.enrollment.completed', 'academic.class.transition', 'academic.progression.approve', 'academic.graduation.approve'] as $operation) {
            $this->assertTrue(AuditEventModel::query()->where('operation', $operation)->exists(), "missing audit trail for {$operation}");
        }
    }

    public function test_delivery_freezes_once_the_class_is_terminal(): void
    {
        ['class_id' => $classId] = $this->freshActiveClass('freeze');
        $officer = $this->academicOfficer('term-freeze');
        $seatId = $this->activeSeat('freeze-seat', $classId);
        $session = app(MaintainClass::class)->scheduleSession($officer, ClassModel::query()->findOrFail($classId), new CarbonImmutable('2026-09-07'), '09:00', '10:00', 'term-freeze-session');
        /** @var ClassSession $sessionRow */
        $sessionRow = ClassSession::query()->findOrFail($session['session_id']);

        app(MaintainEnrollment::class)->complete($officer, Enrollment::query()->findOrFail($seatId), 'finished the term', null, null, 'term-freeze-complete');
        app(MaintainClass::class)->transition($officer, ClassModel::query()->findOrFail($classId), 'completed', 'term-freeze-class');

        try {
            app(RecordAttendance::class)->record($officer, $sessionRow, Enrollment::query()->findOrFail($seatId), 'present', 'term-freeze-att');
            $this->fail('attendance on a completed class must be refused');
        } catch (BusinessRejection $rejection) {
            $this->assertSame('academic.attendance_class_not_active', $rejection->errorCode());
        }

        try {
            app(ManageAssessmentResult::class)->submitAttempt($this->grantedActor('term-freeze-assessor', ['academic.assess']), Enrollment::query()->findOrFail($seatId), 'assessment', 'scan/freeze', 'term-freeze-attempt');
            $this->fail('an attempt on a completed seat must be refused');
        } catch (BusinessRejection $rejection) {
            $this->assertSame('academic.attempt_enrollment_not_active', $rejection->errorCode());
        }

        try {
            app(MaintainEnrollment::class)->request(
                $this->enrollmentClerk('term-freeze-clerk'),
                (string) $this->makeStudent(['initiator' => 'term-adm-init-fz', 'reviewer' => 'term-adm-review-fz', 'approver' => 'term-adm-approve-fz'])['student']->id,
                $classId,
                'term-freeze-enroll',
            );
            $this->fail('a seat request on a completed class must be refused');
        } catch (BusinessRejection $rejection) {
            $this->assertSame('academic.class_not_active', $rejection->errorCode());
        }
    }

    public function test_period_close_refuses_live_delivery_then_succeeds_on_a_terminal_term(): void
    {
        ['period_id' => $periodId, 'class_id' => $classId] = $this->freshActiveClass('period');
        $officer = $this->academicOfficer('term-period');

        try {
            app(MaintainAcademicStructure::class)->transitionPeriod($officer, AcademicPeriod::query()->findOrFail($periodId), 'closed', 'term-period-close-early');
            $this->fail('a period with an active class must not close');
        } catch (BusinessRejection $rejection) {
            $this->assertSame('academic.period_open_classes', $rejection->errorCode());
        }

        $seatId = $this->activeSeat('period-seat', $classId);
        app(MaintainEnrollment::class)->withdraw($this->enrollmentClerk('term-period-clerk'), Enrollment::query()->findOrFail($seatId), 'family relocation verified', 'term-period-wd');
        app(MaintainClass::class)->transition($officer, ClassModel::query()->findOrFail($classId), 'completed', 'term-period-complete');

        $closed = app(MaintainAcademicStructure::class)->transitionPeriod($officer, AcademicPeriod::query()->findOrFail($periodId), 'closed', 'term-period-close');
        $this->assertSame('closed', $closed['lifecycle_state']);

        try {
            app(MaintainClass::class)->defineClass($officer, ClassModel::query()->findOrFail($classId)->program_version_id, $periodId, 4, 'term-period-late');
            $this->fail('no class may be defined in a closed period');
        } catch (BusinessRejection $rejection) {
            $this->assertSame('academic.class_period_unavailable', $rejection->errorCode());
        }
    }

    public function test_terminal_states_are_irreversible(): void
    {
        ['period_id' => $periodId, 'class_id' => $classId] = $this->freshActiveClass('irreversible');
        $officer = $this->academicOfficer('term-irreversible');

        app(MaintainClass::class)->transition($officer, ClassModel::query()->findOrFail($classId), 'cancelled', 'term-irr-cancel');
        foreach (['published', 'active', 'completed'] as $reopen) {
            try {
                app(MaintainClass::class)->transition($officer, ClassModel::query()->findOrFail($classId), $reopen, 'term-irr-'.$reopen);
                $this->fail("a cancelled class must not move to {$reopen}");
            } catch (BusinessRejection $rejection) {
                $this->assertSame('academic.class_transition_forbidden', $rejection->errorCode());
            }
        }

        ['class_id' => $completedId] = $this->freshActiveClass('irreversible-done');
        app(MaintainClass::class)->transition($officer, ClassModel::query()->findOrFail($completedId), 'completed', 'term-irr-complete');
        try {
            app(MaintainClass::class)->transition($officer, ClassModel::query()->findOrFail($completedId), 'active', 'term-irr-reactivate');
            $this->fail('a completed class must not reactivate');
        } catch (BusinessRejection $rejection) {
            $this->assertSame('academic.class_transition_forbidden', $rejection->errorCode());
        }

        app(MaintainAcademicStructure::class)->transitionPeriod($officer, AcademicPeriod::query()->findOrFail($periodId), 'closed', 'term-irr-close');
        try {
            app(MaintainAcademicStructure::class)->transitionPeriod($officer, AcademicPeriod::query()->findOrFail($periodId), 'published', 'term-irr-reopen');
            $this->fail('a closed period must not reopen');
        } catch (BusinessRejection $rejection) {
            $this->assertSame('academic.period_transition_forbidden', $rejection->errorCode());
        }
    }

    public function test_console_cannot_bypass_the_terminal_guards(): void
    {
        ['period_id' => $periodId, 'class_id' => $classId] = $this->freshActiveClass('console');
        $this->activeSeat('console-seat', $classId);
        $this->signInOfficer('console');

        // Bypass attempt 1: cancel the class with a live seat over HTTP.
        $this->post('/academic/classes/'.$classId.'/transition', ['to_state' => 'cancelled'])
            ->assertRedirect()
            ->assertSessionHas('error_code', 'academic.class_open_seats');
        $this->assertSame('active', ClassModel::query()->findOrFail($classId)->lifecycle_state);

        // Bypass attempt 2: close the period while it carries live delivery.
        $this->post('/academic/periods/'.$periodId.'/transition', ['to_state' => 'closed'])
            ->assertRedirect()
            ->assertSessionHas('error_code', 'academic.period_open_classes');
        $this->assertSame('published', AcademicPeriod::query()->findOrFail($periodId)->lifecycle_state);
    }

    public function test_guard_orders_against_late_seat_terminalization(): void
    {
        // Deterministic serialization pin: the guard refuses while the seat
        // is live, permits once the same seat terminalizes, and the terminal
        // class then admits no new seats — the exact interleave a concurrent
        // withdraw-racing-complete must honor.
        ['class_id' => $classId] = $this->freshActiveClass('race');
        $officer = $this->academicOfficer('term-race');
        $seatId = $this->activeSeat('race-seat', $classId);

        try {
            app(MaintainClass::class)->transition($officer, ClassModel::query()->findOrFail($classId), 'completed', 'term-race-same');
            $this->fail('completion with a live seat must be refused');
        } catch (BusinessRejection $rejection) {
            $this->assertSame('academic.class_open_seats', $rejection->errorCode());
        }

        app(MaintainEnrollment::class)->complete($officer, Enrollment::query()->findOrFail($seatId), 'finished the term', null, null, 'term-race-complete');
        // The refusal recorded nothing: retrying the identical command (same
        // key, same payload) after the seat terminalized must succeed rather
        // than replay a refusal or collide on the key.
        app(MaintainClass::class)->transition($officer, ClassModel::query()->findOrFail($classId), 'completed', 'term-race-same');
        $this->assertSame('completed', ClassModel::query()->findOrFail($classId)->lifecycle_state);

        try {
            app(MaintainEnrollment::class)->request(
                $this->enrollmentClerk('term-race-clerk'),
                (string) $this->makeStudent(['initiator' => 'term-adm-init-race', 'reviewer' => 'term-adm-review-race', 'approver' => 'term-adm-approve-race'])['student']->id,
                $classId,
                'term-race-enroll',
            );
            $this->fail('no seat may open on a completed class');
        } catch (BusinessRejection $rejection) {
            $this->assertSame('academic.class_not_active', $rejection->errorCode());
        }
    }
}
