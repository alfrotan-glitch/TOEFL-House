<?php

declare(strict_types=1);

namespace Tests\Feature\Console;

use App\Modules\Academic\Commands\MaintainAcademicStructure;
use App\Modules\Academic\Commands\MaintainClass;
use App\Modules\Academic\Commands\MaintainEnrollment;
use App\Modules\Academic\Models\AcademicPeriod;
use App\Modules\Academic\Models\ClassModel;
use App\Modules\Academic\Models\ClassWaitlistEntry;
use App\Modules\Academic\Models\Enrollment;
use App\Modules\Academic\Models\Program;
use App\Modules\Admissions\Commands\EnrollAdmittedApplicant;
use App\Modules\Admissions\Commands\RegisterApplicant;
use App\Modules\Admissions\Models\Applicant;
use App\Modules\Identity\Models\UserAccount;
use App\Modules\Organization\Models\Branch;
use App\Modules\Students\Models\Student;
use App\Support\Identifiers\RandomIdentifier;
use Carbon\CarbonImmutable;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Hash;
use Tests\Concerns\BuildsActors;
use Tests\Concerns\DecidesAdmissions;
use Tests\TestCase;

/**
 * AC11: the certified class-waitlist workflow is operational through the
 * employee console. Join with ordered positions, duplicate and seat-holder
 * protection, full-only gating, offer requiring a free seat, decline by
 * expire, accept by promote-into-requested, activation through the normal
 * approval path, and governed capability denials are exercised over the
 * real HTTP surface; the domain rules themselves are not re-implemented.
 */
final class WaitlistOperationsConsoleTest extends TestCase
{
    use BuildsActors;
    use DecidesAdmissions;

    private string $branchId;

    private string $levelId;

    private string $periodId;

    private string $programVersionId;

    private string $offeringId;

    private string $classId;

    /** @var array<string, string> */
    private array $students = [];

    private string $seatId;

    protected function setUp(): void
    {
        parent::setUp();

        $officer = $this->academicOfficer('wl-console-setup');
        $structure = app(MaintainAcademicStructure::class);

        $this->branchId = Branch::query()->create([
            'id' => RandomIdentifier::new(),
            'name' => 'Waitlist Branch '.substr(md5(RandomIdentifier::new()), 0, 8),
            'lifecycle_state' => 'active',
        ])->id;

        $program = $structure->defineProgram($officer, 'Waitlist Intensive', 'wl-prog');
        $version = $structure->publishVersion($officer, Program::query()->findOrFail($program['program_id']), 'Waitlist v1', 'wl-ver');
        $this->programVersionId = $version['version_id'];
        $this->levelId = $structure->defineLevel($officer, $this->programVersionId, 'starter', 1, 'Starter', 'A1', 'wl-lvl')['level_id'];

        $this->periodId = $structure->definePeriod($officer, 'Waitlist Term', new CarbonImmutable('2026-10-01'), new CarbonImmutable('2026-12-30'), 'wl-period')['period_id'];
        $structure->transitionPeriod($officer, AcademicPeriod::query()->findOrFail($this->periodId), 'published', 'wl-period-pub');

        $structure->declareBranchAvailability($officer, $this->branchId, $this->levelId, $this->periodId, 'wl-avail');
        $this->offeringId = $structure->openOffering($officer, $this->branchId, $this->levelId, $this->periodId, 1, 'wl-offering')['offering_id'];

        $this->personWithAuthority('wl-teacher-1', []);
        $this->classId = app(MaintainClass::class)->defineClass($officer, $this->programVersionId, $this->periodId, 1, 'wl-class', $this->levelId)['class_id'];
        app(MaintainClass::class)->assignTeacher($officer, ClassModel::query()->findOrFail($this->classId), 'wl-teacher-1', new CarbonImmutable('2026-09-01'), null, 'wl-class-teacher');
        app(MaintainClass::class)->transition($officer, ClassModel::query()->findOrFail($this->classId), 'published', 'wl-class-pub');
        app(MaintainClass::class)->transition($officer, ClassModel::query()->findOrFail($this->classId), 'active', 'wl-class-act');

        foreach (['a', 'b', 'c', 'd', 'e'] as $slot) {
            $this->students[$slot] = $this->newStudent('wl-student-'.$slot);
        }

        $clerk = $this->enrollmentClerk('wl-clerk-setup');
        $this->seatId = app(MaintainEnrollment::class)->request($clerk, $this->students['a'], $this->classId, 'wl-seat-1', $this->offeringId)['enrollment_id'];
        app(MaintainEnrollment::class)->activate($officer, Enrollment::query()->findOrFail($this->seatId), 'wl-seat-2');

        $this->makeEmployee('wl-clerk-1', ['academic.enroll'], 'waitlist-clerk');
        $this->makeEmployee('wl-approver-1', ['academic.enroll', 'academic.enroll_approve'], 'waitlist-approver');
        $this->makeEmployee('wl-stranger-1', [], 'waitlist-stranger');
    }

    private function newStudent(string $personId): string
    {
        $this->personWithAuthority($personId, []);
        $registered = app(RegisterApplicant::class)->register($this->admissionsClerk('wl-clerk-'.$personId), $personId, 'Program', 'wl-reg-'.$personId);
        /** @var Applicant $applicant */
        $applicant = Applicant::query()->findOrFail($registered['applicant_id']);
        $this->runAdmissionDecision(
            $this->admissionsClerk('wl-clerk-'.$personId),
            $this->admissionsReviewer('wl-review-'.$personId),
            $this->admissionsApprover('wl-approve-'.$personId),
            $applicant, true, 'meets policy', 'ev/wl', 'wl-dec-'.$personId,
        );

        return app(EnrollAdmittedApplicant::class)->convert($this->admissionsApprover('wl-approve-'.$personId), $applicant, 'wl-conv-'.$personId)['student_id'];
    }

    private function makeEmployee(string $personId, array $capabilities, string $username): void
    {
        $person = $this->personWithAuthority($personId, $capabilities);
        UserAccount::query()->create([
            'id' => RandomIdentifier::new(),
            'person_id' => $person->id,
            'username' => $username,
            'password_hash' => Hash::make('wl-password-1'),
            'account_state' => UserAccount::STATE_ACTIVE,
        ]);
    }

    private function signIn(string $username): void
    {
        $this->post('/login', ['username' => $username, 'password' => 'wl-password-1'])->assertRedirect('/');
        $this->assertAuthenticated();
    }

    private function signOut(): void
    {
        $this->post('/logout')->assertRedirect('/login');
        $this->assertGuest();
    }

    private function entryId(string $slot): string
    {
        /** @var string $id */
        $id = DB::table('class_waitlist_entries')->where('class_id', $this->classId)->where('student_id', $this->students[$slot])->value('id');
        $this->assertNotNull($id);

        return $id;
    }

    private function join(string $slot, ?string $offeringId = null): void
    {
        $this->post('/academic/waitlist', [
            'student_id' => $this->students[$slot],
            'class_id' => $this->classId,
            'offering_id' => $offeringId,
        ])->assertRedirect('/academic');
    }

    public function test_waitlist_journey_through_console(): void
    {
        $this->signIn('waitlist-clerk');
        $this->get('/academic')->assertOk()->assertSee('Class waitlist')->assertSee('No students waiting');

        // The full class takes two queued students in position order.
        $this->join('b', $this->offeringId);
        $this->join('c', $this->offeringId);
        $this->assertDatabaseHas('class_waitlist_entries', ['id' => $this->entryId('b'), 'position' => 1, 'lifecycle_state' => 'waiting']);
        $this->assertDatabaseHas('class_waitlist_entries', ['id' => $this->entryId('c'), 'position' => 2, 'lifecycle_state' => 'waiting']);

        $codeB = Student::query()->findOrFail($this->students['b'])->student_code;
        $this->get('/academic')->assertOk()->assertSee($codeB);

        // A second open entry and a seat holder cannot queue again.
        $this->post('/academic/waitlist', [
            'student_id' => $this->students['b'],
            'class_id' => $this->classId,
        ], ['referer' => 'http://localhost/academic'])
            ->assertRedirect('/academic')
            ->assertSessionHas('error_code', 'academic.waitlist_entry_exists');
        $this->post('/academic/waitlist', [
            'student_id' => $this->students['a'],
            'class_id' => $this->classId,
        ], ['referer' => 'http://localhost/academic'])
            ->assertRedirect('/academic')
            ->assertSessionHas('error_code', 'academic.enrollment_seat_exists');

        // An offer requires a genuinely free seat.
        $this->signOut();
        $this->signIn('waitlist-approver');
        $this->post('/academic/waitlist/'.$this->entryId('b').'/offer', [], ['referer' => 'http://localhost/academic'])
            ->assertRedirect('/academic')
            ->assertSessionHas('error_code', 'academic.waitlist_class_full');

        // Freeing the seat lets the offer flow complete; the second entry
        // is declined by expiring its offer.
        $this->signOut();
        $this->signIn('waitlist-clerk');
        $this->post('/academic/enrollments/'.$this->seatId.'/withdraw', ['reason' => 'student left the branch'])->assertRedirect('/academic');
        $this->signOut();
        $this->signIn('waitlist-approver');
        $this->post('/academic/waitlist/'.$this->entryId('b').'/offer')->assertRedirect('/academic');
        $this->post('/academic/waitlist/'.$this->entryId('c').'/offer')->assertRedirect('/academic');
        $this->assertDatabaseHas('class_waitlist_entries', ['id' => $this->entryId('c'), 'lifecycle_state' => 'offered']);
        $this->post('/academic/waitlist/'.$this->entryId('c').'/expire')->assertRedirect('/academic');
        $this->assertDatabaseHas('class_waitlist_entries', ['id' => $this->entryId('c'), 'lifecycle_state' => 'expired']);

        // Accepting creates a normal requested seat under the offering —
        // never a silent active seat — and activation follows the normal
        // approval path afterwards.
        $this->post('/academic/waitlist/'.$this->entryId('b').'/promote')->assertRedirect('/academic');
        $this->assertDatabaseHas('class_waitlist_entries', ['id' => $this->entryId('b'), 'lifecycle_state' => 'enrolled']);
        /** @var Enrollment $promoted */
        $promoted = Enrollment::query()->where('student_id', $this->students['b'])->where('class_id', $this->classId)->where('lifecycle_state', 'requested')->firstOrFail();
        $this->assertSame($this->offeringId, trim((string) $promoted->offering_id));

        // With no active seat the class is open again, so queueing is refused.
        $this->signOut();
        $this->signIn('waitlist-clerk');
        $this->post('/academic/waitlist', [
            'student_id' => $this->students['d'],
            'class_id' => $this->classId,
        ], ['referer' => 'http://localhost/academic'])
            ->assertRedirect('/academic')
            ->assertSessionHas('error_code', 'academic.waitlist_not_full');

        $this->signOut();
        $this->signIn('waitlist-approver');
        $this->post('/academic/enrollments/'.$promoted->id.'/activate')->assertRedirect('/academic');
        $this->assertDatabaseHas('enrollments', ['id' => $promoted->id, 'lifecycle_state' => 'active']);

        // The freed queue restarts at position one; withdrawing closes it.
        $this->signOut();
        $this->signIn('waitlist-clerk');
        $this->join('e', $this->offeringId);
        $this->assertDatabaseHas('class_waitlist_entries', ['id' => $this->entryId('e'), 'position' => 1, 'lifecycle_state' => 'waiting']);
        $this->post('/academic/waitlist/'.$this->entryId('e').'/withdraw')->assertRedirect('/academic');
        $this->assertDatabaseHas('class_waitlist_entries', ['id' => $this->entryId('e'), 'lifecycle_state' => 'withdrawn']);

        $this->assertSame(0, ClassWaitlistEntry::query()->where('class_id', $this->classId)->whereIn('lifecycle_state', ['waiting', 'offered'])->count());
        $this->assertDatabaseHas('audit_events', ['operation' => 'academic.waitlist.promote']);
        $this->signOut();
    }

    public function test_waitlist_capabilities_are_denied_governed(): void
    {
        // A stranger holds no enrollment authority at all.
        $this->signIn('waitlist-stranger');
        $this->post('/academic/waitlist', [
            'student_id' => $this->students['b'],
            'class_id' => $this->classId,
        ], ['referer' => 'http://localhost/academic'])
            ->assertRedirect('/academic')
            ->assertSessionHas('error_code', 'academic.waitlist_denied');
        $this->assertDatabaseHas('audit_events', [
            'actor_id' => 'wl-stranger-1',
            'operation' => 'academic.waitlist.join.denied',
            'target_type' => 'class_waitlist_entry',
            'target_id' => $this->classId,
        ]);
        $this->signOut();

        // The clerk holds the queue side only: staff-side transitions stay
        // out of reach even on an entry she queued herself.
        $this->signIn('waitlist-clerk');
        $this->join('b', $this->offeringId);
        $this->post('/academic/waitlist/'.$this->entryId('b').'/offer', [], ['referer' => 'http://localhost/academic'])
            ->assertRedirect('/academic')
            ->assertSessionHas('error_code', 'academic.waitlist_denied');
        $this->assertDatabaseHas('class_waitlist_entries', ['id' => $this->entryId('b'), 'lifecycle_state' => 'waiting']);
        $this->signOut();
    }
}
