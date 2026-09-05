<?php

declare(strict_types=1);

namespace Tests\Feature\Console;

use App\Modules\Academic\Commands\MaintainAcademicStructure;
use App\Modules\Academic\Commands\MaintainClass;
use App\Modules\Academic\Models\AcademicPeriod;
use App\Modules\Academic\Models\ClassModel;
use App\Modules\Academic\Models\Program;
use App\Modules\Admissions\Commands\DecideAdmission;
use App\Modules\Admissions\Commands\EnrollAdmittedApplicant;
use App\Modules\Admissions\Commands\RegisterApplicant;
use App\Modules\Admissions\Models\AdmissionDecision;
use App\Modules\Admissions\Models\Applicant;
use App\Modules\Identity\Models\Person;
use App\Modules\Identity\Models\UserAccount;
use App\Support\Identifiers\RandomIdentifier;
use Carbon\CarbonImmutable;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Hash;
use Tests\Concerns\BuildsActors;
use Tests\TestCase;

/**
 * AC13: the complete progression decision lifecycle over the employee
 * console — propose (with optional evidence) → review → approve →
 * appeal filed → marked appealed → superseded with lineage → seat
 * completed on the successor evidence — plus the reject path,
 * evidence/open-decision refusals, proposer-exclusion on supersede,
 * and governed capability denials. Every signature is captured in its
 * own authenticated session; the transport never types a colleague's
 * id and never re-implements domain rules.
 */
final class ProgressionLifecycleConsoleTest extends TestCase
{
    use BuildsActors;

    private string $classId;

    protected function setUp(): void
    {
        parent::setUp();

        $officer = $this->academicOfficer();
        $program = app(MaintainAcademicStructure::class)->defineProgram($officer, 'IELTS Preparation', 'plc-prog');
        $version = app(MaintainAcademicStructure::class)->publishVersion($officer, Program::query()->findOrFail($program['program_id']), 'lifecycle rules', 'plc-ver');
        $period = app(MaintainAcademicStructure::class)->definePeriod($officer, 'Fall 2026', new CarbonImmutable('2026-09-01'), new CarbonImmutable('2026-12-18'), 'plc-period');
        app(MaintainAcademicStructure::class)->transitionPeriod($officer, AcademicPeriod::query()->findOrFail($period['period_id']), 'published', 'plc-period-pub');

        $class = app(MaintainClass::class)->defineClass($officer, $version['version_id'], $period['period_id'], 4, 'plc-class');
        $this->classId = $class['class_id'];
        $this->personWithAuthority('plc-teacher-1', []);
        app(MaintainClass::class)->assignTeacher($officer, ClassModel::query()->findOrFail($this->classId), 'plc-teacher-1', new CarbonImmutable('2026-09-01'), null, 'plc-ta');
        app(MaintainClass::class)->transition($officer, ClassModel::query()->findOrFail($this->classId), 'published', 'plc-cls-pub');
        app(MaintainClass::class)->transition($officer, ClassModel::query()->findOrFail($this->classId), 'active', 'plc-cls-act');
    }

    /** @return array{0: Person, 1: UserAccount} */
    private function makeEmployee(string $personId, array $capabilities, string $username): array
    {
        $person = $this->personWithAuthority($personId, $capabilities);
        $account = UserAccount::query()->create([
            'id' => RandomIdentifier::new(),
            'person_id' => $person->id,
            'username' => $username,
            'password_hash' => Hash::make('plc-password-1'),
            'account_state' => UserAccount::STATE_ACTIVE,
        ]);

        return [$person, $account];
    }

    private function signIn(string $username): void
    {
        $this->post('/login', ['username' => $username, 'password' => 'plc-password-1'])->assertRedirect('/');
        $this->assertAuthenticated();
    }

    private function signOut(): void
    {
        $this->post('/logout')->assertRedirect('/login');
        $this->assertGuest();
    }

    /**
     * One admitted student, built through the authoritative staged
     * admissions pipeline (initiate/review/approve/convert).
     */
    private function newStudent(string $suffix): string
    {
        $personId = 'plc-stu-'.$suffix;
        $this->personWithAuthority($personId, []);

        $registered = app(RegisterApplicant::class)->register(
            $this->admissionsClerk('plc-clerk-'.$suffix), $personId, 'IELTS Preparation', 'plc-reg-'.$suffix,
        );
        /** @var Applicant $applicant */
        $applicant = Applicant::query()->findOrFail($registered['applicant_id']);

        $initiated = app(DecideAdmission::class)->initiate(
            $this->admissionsClerk('plc-clerk2-'.$suffix), $applicant, true, 'meets entry policy', 'interview-notes/'.$suffix, 'plc-deci-'.$suffix,
        );
        $decision = AdmissionDecision::query()->findOrFail($initiated['decision_id']);
        app(DecideAdmission::class)->review($this->admissionsReviewer('plc-rev-'.$suffix), $decision, 'plc-decr-'.$suffix);
        app(DecideAdmission::class)->approve($this->admissionsApprover('plc-adv-'.$suffix), $decision, 'plc-deca-'.$suffix);

        $converted = app(EnrollAdmittedApplicant::class)->convert($this->admissionsApprover('plc-adv2-'.$suffix), $applicant, 'plc-conv-'.$suffix);

        return $converted['student_id'];
    }

    private function decisions(): string
    {
        return DB::connection()->getTablePrefix().'progression_decisions';
    }

    private function activeSeatFor(string $studentId): string
    {
        $this->post('/academic/enrollments', [
            'student_id' => $studentId,
            'class_id' => $this->classId,
        ])->assertRedirect('/academic');
        /** @var string $seatId */
        $seatId = DB::table(DB::connection()->getTablePrefix().'enrollments')->where('student_id', $studentId)->value('id');
        $this->assertNotNull($seatId);

        return $seatId;
    }

    public function test_full_decision_lifecycle_through_the_console(): void
    {
        $this->makeEmployee('plc-prop-1', ['academic.progression_propose'], 'decider-proposer');
        $this->makeEmployee('plc-rev-1', ['academic.progression_review'], 'decider-reviewer');
        $this->makeEmployee('plc-app-1', ['academic.progression_approve'], 'decider-approver');
        $this->makeEmployee('plc-sup-1', ['academic.progression_review', 'academic.progression_approve'], 'decider-superseder');
        $this->makeEmployee('plc-clerk-1', ['academic.enroll'], 'decider-clerk');
        $this->makeEmployee('plc-seat-1', ['academic.enroll_approve'], 'decider-seat');
        $this->makeEmployee('plc-fil-1', ['academic.appeal_manage'], 'decider-filer');
        $studentId = $this->newStudent('life');

        // Seat request by the clerk, activation by the seat officer.
        $this->signIn('decider-clerk');
        $seatId = $this->activeSeatFor($studentId);
        $this->signOut();
        $this->signIn('decider-seat');
        $this->post('/academic/enrollments/'.$seatId.'/activate')->assertRedirect('/academic');
        $this->signOut();

        // Proposal, review, and approval by three distinct employees.
        $this->signIn('decider-proposer');
        $this->post('/academic/progressions', [
            'student_id' => $studentId,
            'class_id' => $this->classId,
            'outcome' => 'advance',
            'reason' => 'meets the exit criteria',
        ])->assertRedirect('/academic');
        $decisionId = DB::table($this->decisions())->where('student_id', $studentId)->value('id');
        $this->assertNotNull($decisionId);
        $this->assertDatabaseHas($this->decisions(), ['id' => $decisionId, 'lifecycle_state' => 'proposed']);
        $this->signOut();

        $this->signIn('decider-reviewer');
        $this->post('/academic/progressions/'.$decisionId.'/review')->assertRedirect('/academic');
        $this->assertDatabaseHas($this->decisions(), ['id' => $decisionId, 'lifecycle_state' => 'reviewed']);
        $this->signOut();

        $this->signIn('decider-approver');
        $this->post('/academic/progressions/'.$decisionId.'/approve')->assertRedirect('/academic');
        $this->assertDatabaseHas($this->decisions(), ['id' => $decisionId, 'lifecycle_state' => 'approved']);
        $this->signOut();

        // An appeal is filed against the approved decision, then the
        // record is marked appealed by the independent reviewer.
        $this->signIn('decider-filer');
        $this->post('/academic/appeals', [
            'student_id' => $studentId,
            'subject_type' => 'progression_decision',
            'subject_id' => $decisionId,
            'reason' => 'the exit evidence was misread',
        ])->assertRedirect('/academic');
        $this->signOut();

        $this->signIn('decider-reviewer');
        $this->post('/academic/progressions/'.$decisionId.'/mark-appealed')->assertRedirect('/academic');
        $this->assertDatabaseHas($this->decisions(), ['id' => $decisionId, 'lifecycle_state' => 'appealed']);
        $this->signOut();

        // The appeal outcome supersedes the original: the original row
        // stays as history pointing at its approved successor.
        $this->signIn('decider-superseder');
        $this->post('/academic/progressions/'.$decisionId.'/supersede', [
            'outcome' => 'repeat',
            'reason' => 'appeal upheld: the exit evidence does not support advance',
        ])->assertRedirect('/academic');
        $successorId = DB::table($this->decisions())->where('student_id', $studentId)->where('lifecycle_state', 'approved')->value('id');
        $this->assertNotNull($successorId);
        $this->assertNotSame($decisionId, $successorId);
        $this->assertDatabaseHas($this->decisions(), [
            'id' => $decisionId, 'lifecycle_state' => 'superseded', 'superseded_by_id' => $successorId,
        ]);
        $this->assertDatabaseHas($this->decisions(), [
            'id' => $successorId, 'outcome' => 'repeat', 'lifecycle_state' => 'approved',
        ]);
        $this->signOut();

        // The seat completes on the successor evidence…
        $this->signIn('decider-seat');
        $this->post('/academic/enrollments/'.$seatId.'/complete', [
            'basis' => 'appeal outcome applied',
            'evidence_kind' => 'progression_decision',
            'evidence_id' => $successorId,
        ])->assertRedirect('/academic');
        $this->assertDatabaseHas(DB::connection()->getTablePrefix().'enrollments', [
            'id' => $seatId, 'lifecycle_state' => 'completed',
        ]);
        $this->signOut();

        // …while the superseded original is refused as evidence on a
        // second active seat.
        $this->makeEmployee('plc-clerk-2', ['academic.enroll'], 'decider-clerk-2');
        $otherStudentId = $this->newStudent('life2');
        $this->signIn('decider-clerk-2');
        $otherSeatId = $this->activeSeatFor($otherStudentId);
        $this->signOut();
        $this->signIn('decider-seat');
        $this->post('/academic/enrollments/'.$otherSeatId.'/activate')->assertRedirect('/academic');
        $this->post('/academic/enrollments/'.$otherSeatId.'/complete', [
            'basis' => 'attempted close-out on history',
            'evidence_kind' => 'progression_decision',
            'evidence_id' => $decisionId,
        ], ['referer' => 'http://localhost/academic'])
            ->assertRedirect('/academic')
            ->assertSessionHas('error_code', 'academic.enrollment_completion_evidence_mismatch');
        $this->assertDatabaseHas(DB::connection()->getTablePrefix().'enrollments', [
            'id' => $otherSeatId, 'lifecycle_state' => 'active',
        ]);
    }

    public function test_reject_path_and_rejected_to_appealed_through_the_console(): void
    {
        $this->makeEmployee('plc-prop-2', ['academic.progression_propose'], 'reject-proposer');
        $this->makeEmployee('plc-rev-2', ['academic.progression_review'], 'reject-reviewer');
        $this->makeEmployee('plc-app-2', ['academic.progression_approve'], 'reject-approver');
        $studentId = $this->newStudent('rej');

        $this->signIn('reject-proposer');
        $this->post('/academic/progressions', [
            'student_id' => $studentId,
            'class_id' => $this->classId,
            'outcome' => 'advance',
            'reason' => 'borderline exit evidence',
        ])->assertRedirect('/academic');
        $decisionId = DB::table($this->decisions())->where('student_id', $studentId)->value('id');
        $this->assertNotNull($decisionId);
        $this->signOut();

        // Rejection is only valid once reviewed.
        $this->signIn('reject-approver');
        $this->post('/academic/progressions/'.$decisionId.'/reject', [], ['referer' => 'http://localhost/academic'])
            ->assertRedirect('/academic')
            ->assertSessionHas('error_code', 'academic.progression_transition_forbidden');
        $this->assertDatabaseHas($this->decisions(), ['id' => $decisionId, 'lifecycle_state' => 'proposed']);
        $this->signOut();

        $this->signIn('reject-reviewer');
        $this->post('/academic/progressions/'.$decisionId.'/review')->assertRedirect('/academic');
        $this->signOut();

        $this->signIn('reject-approver');
        $this->post('/academic/progressions/'.$decisionId.'/reject')->assertRedirect('/academic');
        $this->assertDatabaseHas($this->decisions(), ['id' => $decisionId, 'lifecycle_state' => 'rejected']);
        $this->signOut();

        // A rejected decision can still be marked appealed.
        $this->signIn('reject-reviewer');
        $this->post('/academic/progressions/'.$decisionId.'/mark-appealed')->assertRedirect('/academic');
        $this->assertDatabaseHas($this->decisions(), ['id' => $decisionId, 'lifecycle_state' => 'appealed']);
    }

    public function test_evidence_fields_and_open_decisions_are_refused_on_legacy_classes(): void
    {
        $this->makeEmployee('plc-prop-3', ['academic.progression_propose'], 'evidence-proposer');
        $studentId = $this->newStudent('evi');

        $this->signIn('evidence-proposer');
        // This class carries no level, so level-aware evidence fields
        // are refused by the certified path.
        $this->post('/academic/progressions', [
            'student_id' => $studentId,
            'class_id' => $this->classId,
            'outcome' => 'advance',
            'reason' => 'meets the exit criteria',
            'basis' => 'exit interview',
        ], ['referer' => 'http://localhost/academic'])
            ->assertRedirect('/academic')
            ->assertSessionHas('error_code', 'academic.progression_level_unexpected');
        $this->assertSame(0, DB::table($this->decisions())->where('student_id', $studentId)->count());

        $this->post('/academic/progressions', [
            'student_id' => $studentId,
            'class_id' => $this->classId,
            'outcome' => 'advance',
            'reason' => 'meets the exit criteria',
        ])->assertRedirect('/academic');

        // A second proposal while one is open is refused.
        $this->post('/academic/progressions', [
            'student_id' => $studentId,
            'class_id' => $this->classId,
            'outcome' => 'repeat',
            'reason' => 'second opinion',
        ], ['referer' => 'http://localhost/academic'])
            ->assertRedirect('/academic')
            ->assertSessionHas('error_code', 'academic.progression_open_decision');
        $this->assertSame(1, DB::table($this->decisions())->where('student_id', $studentId)->count());
    }

    public function test_supersede_refuses_the_original_proposer(): void
    {
        // One employee holding every progression capability still
        // cannot supersede a decision they proposed themselves.
        $this->makeEmployee('plc-all-4', ['academic.progression_propose', 'academic.progression_review', 'academic.progression_approve'], 'all-signer');
        $this->makeEmployee('plc-rev-4', ['academic.progression_review'], 'other-reviewer');
        $this->makeEmployee('plc-app-4', ['academic.progression_approve'], 'other-approver');
        $studentId = $this->newStudent('sod');

        $this->signIn('all-signer');
        $this->post('/academic/progressions', [
            'student_id' => $studentId,
            'class_id' => $this->classId,
            'outcome' => 'advance',
            'reason' => 'meets the exit criteria',
        ])->assertRedirect('/academic');
        $decisionId = DB::table($this->decisions())->where('student_id', $studentId)->value('id');
        $this->assertNotNull($decisionId);
        $this->signOut();

        $this->signIn('other-reviewer');
        $this->post('/academic/progressions/'.$decisionId.'/review')->assertRedirect('/academic');
        $this->signOut();

        $this->signIn('other-approver');
        $this->post('/academic/progressions/'.$decisionId.'/approve')->assertRedirect('/academic');
        $this->signOut();

        $this->signIn('all-signer');
        $this->post('/academic/progressions/'.$decisionId.'/supersede', [
            'outcome' => 'repeat',
            'reason' => 'self-correction attempt',
        ], ['referer' => 'http://localhost/academic'])
            ->assertRedirect('/academic')
            ->assertSessionHas('error_code', 'academic.appeal_not_independent');
        $this->assertDatabaseHas($this->decisions(), ['id' => $decisionId, 'lifecycle_state' => 'approved']);
    }

    public function test_progression_lifecycle_denies_employees_without_capability(): void
    {
        $this->makeEmployee('plc-prop-5', ['academic.progression_propose'], 'capped-proposer');
        $this->makeEmployee('plc-plain-5', [], 'uncapped');
        $studentId = $this->newStudent('den');

        $this->signIn('uncapped');
        $this->post('/academic/progressions', [
            'student_id' => $studentId,
            'class_id' => $this->classId,
            'outcome' => 'advance',
            'reason' => 'no authority behind this',
        ], ['referer' => 'http://localhost/academic'])
            ->assertRedirect('/academic')
            ->assertSessionHas('error_code', 'academic.progression_denied');
        $this->assertSame(0, DB::table($this->decisions())->where('student_id', $studentId)->count());
        $this->signOut();

        $this->signIn('capped-proposer');
        $this->post('/academic/progressions', [
            'student_id' => $studentId,
            'class_id' => $this->classId,
            'outcome' => 'advance',
            'reason' => 'meets the exit criteria',
        ])->assertRedirect('/academic');
        $decisionId = DB::table($this->decisions())->where('student_id', $studentId)->value('id');
        $this->assertNotNull($decisionId);
        $this->signOut();

        // The uncapped employee can sign nothing further on the record.
        $this->signIn('uncapped');
        $this->post('/academic/progressions/'.$decisionId.'/review', [], ['referer' => 'http://localhost/academic'])
            ->assertRedirect('/academic')
            ->assertSessionHas('error_code', 'academic.progression_denied');
        $this->assertDatabaseHas($this->decisions(), ['id' => $decisionId, 'lifecycle_state' => 'proposed']);
    }
}
