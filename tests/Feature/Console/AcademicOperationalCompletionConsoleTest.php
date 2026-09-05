<?php

declare(strict_types=1);

namespace Tests\Feature\Console;

use App\Modules\Academic\Commands\MaintainAcademicStructure;
use App\Modules\Academic\Models\AcademicPeriod;
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
 * AC14: the four remaining Academic operational gaps over the employee
 * console — level definition (R1), level-targeted class creation (R2),
 * seat transfer with append-only lineage (R3), and attendance
 * correction with append-only lineage (R4). Transport only: every
 * rule, capability, idempotency slot, and audit event stays in the
 * certified commands; each signature is captured in its own
 * authenticated session.
 */
final class AcademicOperationalCompletionConsoleTest extends TestCase
{
    use BuildsActors;

    private string $versionId;

    private string $periodId;

    protected function setUp(): void
    {
        parent::setUp();

        $officer = $this->academicOfficer();
        $program = app(MaintainAcademicStructure::class)->defineProgram($officer, 'IELTS Preparation', 'aoc-prog');
        $version = app(MaintainAcademicStructure::class)->publishVersion($officer, Program::query()->findOrFail($program['program_id']), 'completion rules', 'aoc-ver');
        $this->versionId = $version['version_id'];
        $period = app(MaintainAcademicStructure::class)->definePeriod($officer, 'Fall 2026', new CarbonImmutable('2026-09-01'), new CarbonImmutable('2026-12-18'), 'aoc-period');
        app(MaintainAcademicStructure::class)->transitionPeriod($officer, AcademicPeriod::query()->findOrFail($period['period_id']), 'published', 'aoc-period-pub');
        $this->periodId = $period['period_id'];
    }

    /** @return array{0: Person, 1: UserAccount} */
    private function makeEmployee(string $personId, array $capabilities, string $username): array
    {
        $person = $this->personWithAuthority($personId, $capabilities);
        $account = UserAccount::query()->create([
            'id' => RandomIdentifier::new(),
            'person_id' => $person->id,
            'username' => $username,
            'password_hash' => Hash::make('aoc-password-1'),
            'account_state' => UserAccount::STATE_ACTIVE,
        ]);

        return [$person, $account];
    }

    private function signIn(string $username): void
    {
        $this->post('/login', ['username' => $username, 'password' => 'aoc-password-1'])->assertRedirect('/');
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
        $personId = 'aoc-stu-'.$suffix;
        $this->personWithAuthority($personId, []);

        $registered = app(RegisterApplicant::class)->register(
            $this->admissionsClerk('aoc-clerk-'.$suffix), $personId, 'IELTS Preparation', 'aoc-reg-'.$suffix,
        );
        /** @var Applicant $applicant */
        $applicant = Applicant::query()->findOrFail($registered['applicant_id']);

        $initiated = app(DecideAdmission::class)->initiate(
            $this->admissionsClerk('aoc-clerk2-'.$suffix), $applicant, true, 'meets entry policy', 'interview-notes/'.$suffix, 'aoc-deci-'.$suffix,
        );
        $decision = AdmissionDecision::query()->findOrFail($initiated['decision_id']);
        app(DecideAdmission::class)->review($this->admissionsReviewer('aoc-rev-'.$suffix), $decision, 'aoc-decr-'.$suffix);
        app(DecideAdmission::class)->approve($this->admissionsApprover('aoc-adv-'.$suffix), $decision, 'aoc-deca-'.$suffix);

        $converted = app(EnrollAdmittedApplicant::class)->convert($this->admissionsApprover('aoc-adv2-'.$suffix), $applicant, 'aoc-conv-'.$suffix);

        return $converted['student_id'];
    }

    private function prefix(): string
    {
        return DB::connection()->getTablePrefix();
    }

    /**
     * Define a class over HTTP and drive it to active with a teacher,
     * returning its id.
     */
    private function activeClass(string $suffix, ?string $levelId = null): string
    {
        $payload = [
            'program_version_id' => $this->versionId,
            'period_id' => $this->periodId,
            'capacity' => 2,
        ];
        if ($levelId !== null) {
            $payload['program_version_level_id'] = $levelId;
        }
        $knownIds = DB::table($this->prefix().'classes')->pluck('id')->all();
        $this->post('/academic/classes', $payload)->assertRedirect('/academic');
        /** @var string $classId */
        $classId = DB::table($this->prefix().'classes')->whereNotIn('id', $knownIds)->value('id');
        $this->assertNotNull($classId);

        $this->personWithAuthority('aoc-teacher-'.$suffix, []);
        $this->post('/academic/teacher-assignments', [
            'class_id' => $classId,
            'teacher_person_id' => 'aoc-teacher-'.$suffix,
            'effective_from' => '2026-09-01',
        ])->assertRedirect('/academic');
        $this->post('/academic/classes/'.$classId.'/transition', ['to_state' => 'published'])->assertRedirect('/academic');
        $this->post('/academic/classes/'.$classId.'/transition', ['to_state' => 'active'])->assertRedirect('/academic');

        return $classId;
    }

    public function test_level_define_and_level_targeted_class_define_through_the_console(): void
    {
        $this->makeEmployee('aoc-struct-1', ['academic.structure'], 'level-keeper');
        $this->makeEmployee('aoc-sched-1', ['academic.schedule'], 'level-scheduler');
        $this->makeEmployee('aoc-plain-1', [], 'level-stranger');

        // Levels are defined by the structure employee in her own session.
        $this->signIn('level-keeper');
        $this->post('/academic/levels', [
            'program_version_id' => $this->versionId,
            'level_key' => 'starter',
            'ordinal' => 1,
            'title' => 'Starter',
            'cefr_ref' => 'A1',
        ])->assertRedirect('/academic');
        $this->assertDatabaseHas($this->prefix().'program_version_levels', [
            'program_version_id' => $this->versionId, 'level_key' => 'starter', 'ordinal' => 1, 'lifecycle_state' => 'active',
        ]);
        $levelId = DB::table($this->prefix().'program_version_levels')->where('program_version_id', $this->versionId)->where('level_key', 'starter')->value('id');
        $this->assertNotNull($levelId);

        // Key and ordinal stay unique per version.
        $this->post('/academic/levels', [
            'program_version_id' => $this->versionId,
            'level_key' => 'starter',
            'ordinal' => 2,
            'title' => 'Starter duplicate',
        ], ['referer' => 'http://localhost/academic'])
            ->assertRedirect('/academic')
            ->assertSessionHas('error_code', 'academic.level_key_exists');
        $this->post('/academic/levels', [
            'program_version_id' => $this->versionId,
            'level_key' => 'elementary',
            'ordinal' => 1,
            'title' => 'Elementary',
        ], ['referer' => 'http://localhost/academic'])
            ->assertRedirect('/academic')
            ->assertSessionHas('error_code', 'academic.level_ordinal_exists');
        $this->assertSame(1, DB::table($this->prefix().'program_version_levels')->where('program_version_id', $this->versionId)->count());
        $this->signOut();

        // Without the structure capability, definition is refused.
        $this->signIn('level-stranger');
        $this->post('/academic/levels', [
            'program_version_id' => $this->versionId,
            'level_key' => 'sneaky',
            'ordinal' => 9,
            'title' => 'Sneaky',
        ], ['referer' => 'http://localhost/academic'])
            ->assertRedirect('/academic')
            ->assertSessionHas('error_code', 'academic.structure_denied');
        $this->signOut();

        // The scheduler targets the level when defining the class.
        $this->signIn('level-scheduler');
        $classId = $this->activeClass('lvl', $levelId);
        $this->assertDatabaseHas($this->prefix().'classes', [
            'id' => $classId, 'program_version_id' => $this->versionId, 'program_version_level_id' => $levelId,
        ]);
        $this->signOut();

        // A level from another version cannot be attached to the class.
        $officer = $this->academicOfficer();
        $otherProgram = app(MaintainAcademicStructure::class)->defineProgram($officer, 'Other', 'aoc-prog-x');
        $otherVersion = app(MaintainAcademicStructure::class)->publishVersion($officer, Program::query()->findOrFail($otherProgram['program_id']), 'other v1', 'aoc-ver-x');
        $otherLevel = app(MaintainAcademicStructure::class)->defineLevel($officer, $otherVersion['version_id'], 'starter', 1, 'Starter', 'A1', 'aoc-lvl-x');

        $this->signIn('level-scheduler');
        $this->post('/academic/classes', [
            'program_version_id' => $this->versionId,
            'period_id' => $this->periodId,
            'capacity' => 2,
            'program_version_level_id' => $otherLevel['level_id'],
        ], ['referer' => 'http://localhost/academic'])
            ->assertRedirect('/academic')
            ->assertSessionHas('error_code', 'academic.class_level_version_mismatch');
    }

    public function test_seat_transfer_through_the_console(): void
    {
        $this->makeEmployee('aoc-sched-2', ['academic.schedule'], 'transfer-scheduler');
        $this->makeEmployee('aoc-clerk-2', ['academic.enroll'], 'transfer-clerk');
        $this->makeEmployee('aoc-seat-2', ['academic.enroll_approve'], 'transfer-officer');
        $studentId = $this->newStudent('tra');

        $this->signIn('transfer-scheduler');
        $fromClassId = $this->activeClass('tra-a');
        $toClassId = $this->activeClass('tra-b');
        $this->signOut();

        $this->signIn('transfer-clerk');
        $this->post('/academic/enrollments', [
            'student_id' => $studentId,
            'class_id' => $fromClassId,
        ])->assertRedirect('/academic');
        $seatId = DB::table($this->prefix().'enrollments')->where('student_id', $studentId)->value('id');
        $this->assertNotNull($seatId);
        $this->signOut();

        $this->signIn('transfer-officer');
        $this->post('/academic/enrollments/'.$seatId.'/activate')->assertRedirect('/academic');

        // Transfer closes the old seat and opens a requested seat in
        // the target class; history is never mutated.
        $this->post('/academic/enrollments/'.$seatId.'/transfer', [
            'target_class_id' => $toClassId,
        ])->assertRedirect('/academic');
        $this->assertDatabaseHas($this->prefix().'enrollments', [
            'id' => $seatId, 'lifecycle_state' => 'transferred',
        ]);
        $nextSeatId = DB::table($this->prefix().'enrollments')
            ->where('student_id', $studentId)->where('class_id', $toClassId)->value('id');
        $this->assertNotNull($nextSeatId);
        $this->assertNotSame($seatId, $nextSeatId);
        $this->assertDatabaseHas($this->prefix().'enrollments', [
            'id' => $nextSeatId, 'lifecycle_state' => 'requested',
        ]);

        // The transferred seat reactivates under a fresh financial gate.
        $this->post('/academic/enrollments/'.$nextSeatId.'/activate')->assertRedirect('/academic');
        $this->assertDatabaseHas($this->prefix().'enrollments', [
            'id' => $nextSeatId, 'lifecycle_state' => 'active',
        ]);

        // A transfer back to the same class is refused.
        $this->post('/academic/enrollments/'.$nextSeatId.'/transfer', [
            'target_class_id' => $toClassId,
        ], ['referer' => 'http://localhost/academic'])
            ->assertRedirect('/academic')
            ->assertSessionHas('error_code', 'academic.transfer_same_class');
        $this->signOut();

        // A frozen seat cannot be transferred.
        $this->signIn('transfer-officer');
        $this->post('/academic/enrollments/'.$nextSeatId.'/freeze', ['reason' => 'fee review'])->assertRedirect('/academic');
        $this->post('/academic/enrollments/'.$nextSeatId.'/transfer', [
            'target_class_id' => $fromClassId,
        ], ['referer' => 'http://localhost/academic'])
            ->assertRedirect('/academic')
            ->assertSessionHas('error_code', 'academic.enrollment_transition_forbidden');
        $this->assertDatabaseHas($this->prefix().'enrollments', [
            'id' => $nextSeatId, 'lifecycle_state' => 'frozen',
        ]);
    }

    public function test_transfer_denies_employees_without_capability(): void
    {
        $this->makeEmployee('aoc-sched-3', ['academic.schedule'], 'transfer-scheduler-3');
        $this->makeEmployee('aoc-clerk-3', ['academic.enroll'], 'transfer-clerk-3');
        $this->makeEmployee('aoc-seat-3', ['academic.enroll_approve'], 'transfer-officer-3');
        $this->makeEmployee('aoc-plain-3', [], 'transfer-stranger');
        $studentId = $this->newStudent('trd');

        $this->signIn('transfer-scheduler-3');
        $fromClassId = $this->activeClass('trd-a');
        $toClassId = $this->activeClass('trd-b');
        $this->signOut();

        $this->signIn('transfer-clerk-3');
        $this->post('/academic/enrollments', [
            'student_id' => $studentId,
            'class_id' => $fromClassId,
        ])->assertRedirect('/academic');
        $seatId = DB::table($this->prefix().'enrollments')->where('student_id', $studentId)->value('id');
        $this->signOut();

        $this->signIn('transfer-officer-3');
        $this->post('/academic/enrollments/'.$seatId.'/activate')->assertRedirect('/academic');
        $this->signOut();

        $this->signIn('transfer-stranger');
        $this->post('/academic/enrollments/'.$seatId.'/transfer', [
            'target_class_id' => $toClassId,
        ], ['referer' => 'http://localhost/academic'])
            ->assertRedirect('/academic')
            ->assertSessionHas('error_code', 'academic.enrollment_denied');
        $this->assertDatabaseHas($this->prefix().'enrollments', [
            'id' => $seatId, 'lifecycle_state' => 'active',
        ]);
        $this->assertSame(1, DB::table($this->prefix().'enrollments')->where('student_id', $studentId)->count());
    }

    public function test_attendance_correction_through_the_console(): void
    {
        $this->makeEmployee('aoc-sched-4', ['academic.schedule'], 'correction-scheduler');
        $this->makeEmployee('aoc-clerk-4', ['academic.enroll'], 'correction-clerk');
        $this->makeEmployee('aoc-seat-4', ['academic.enroll_approve'], 'correction-officer');
        $this->makeEmployee('aoc-att-4', ['academic.attendance'], 'correction-recorder');
        $this->makeEmployee('aoc-plain-4', [], 'correction-stranger');
        $studentId = $this->newStudent('cor');

        $this->signIn('correction-scheduler');
        $classId = $this->activeClass('cor-a');
        $this->post('/academic/sessions', [
            'class_id' => $classId,
            'scheduled_on' => '2026-09-15',
            'starts_at' => '09:00',
            'ends_at' => '10:30',
        ])->assertRedirect('/academic/sessions');
        $sessionId = DB::table($this->prefix().'class_sessions')->where('class_id', $classId)->value('id');
        $this->assertNotNull($sessionId);
        $this->signOut();

        $this->signIn('correction-clerk');
        $this->post('/academic/enrollments', [
            'student_id' => $studentId,
            'class_id' => $classId,
        ])->assertRedirect('/academic');
        $seatId = DB::table($this->prefix().'enrollments')->where('student_id', $studentId)->value('id');
        $this->signOut();

        $this->signIn('correction-officer');
        $this->post('/academic/enrollments/'.$seatId.'/activate')->assertRedirect('/academic');
        $this->signOut();

        // Record, then correct with a mandatory reason.
        $this->signIn('correction-recorder');
        $this->post('/academic/sessions/'.$sessionId.'/attendance', [
            'enrollment_id' => $seatId,
            'status' => 'absent',
        ])->assertRedirect('/academic/sessions');
        $factId = DB::table($this->prefix().'attendance_facts')->where('enrollment_id', $seatId)->value('id');
        $this->assertNotNull($factId);

        $this->post('/academic/sessions/facts/'.$factId.'/correct', [
            'status' => 'present',
            'reason' => 'register marked the wrong row',
        ])->assertRedirect('/academic/sessions');
        $correctionId = DB::table($this->prefix().'attendance_facts')->where('corrects_id', $factId)->value('id');
        $this->assertNotNull($correctionId);
        $this->assertDatabaseHas($this->prefix().'attendance_facts', [
            'id' => $correctionId, 'status' => 'present', 'corrects_id' => $factId,
        ]);
        // The original fact is untouched history.
        $this->assertDatabaseHas($this->prefix().'attendance_facts', [
            'id' => $factId, 'status' => 'absent', 'corrects_id' => null,
        ]);
        $this->signOut();

        // Without the attendance capability, correction is refused.
        $this->signIn('correction-stranger');
        $this->post('/academic/sessions/facts/'.$factId.'/correct', [
            'status' => 'late',
            'reason' => 'no authority behind this',
        ], ['referer' => 'http://localhost/academic/sessions'])
            ->assertRedirect('/academic/sessions')
            ->assertSessionHas('error_code', 'academic.attendance_denied');
        $this->assertSame(2, DB::table($this->prefix().'attendance_facts')->where('enrollment_id', $seatId)->count());
        $this->signOut();

        // Once the seat leaves active, correction is refused by the domain.
        $this->signIn('correction-officer');
        $this->post('/academic/enrollments/'.$seatId.'/freeze', ['reason' => 'fee review'])->assertRedirect('/academic');
        $this->signOut();

        $this->signIn('correction-recorder');
        $this->post('/academic/sessions/facts/'.$factId.'/correct', [
            'status' => 'excused',
            'reason' => 'late evidence arrived',
        ], ['referer' => 'http://localhost/academic/sessions'])
            ->assertRedirect('/academic/sessions')
            ->assertSessionHas('error_code', 'academic.attendance_enrollment_not_active');
        $this->assertSame(2, DB::table($this->prefix().'attendance_facts')->where('enrollment_id', $seatId)->count());
    }
}
