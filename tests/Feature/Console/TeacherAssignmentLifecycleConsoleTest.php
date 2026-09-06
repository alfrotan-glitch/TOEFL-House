<?php

declare(strict_types=1);

namespace Tests\Feature\Console;

use App\Modules\Academic\Commands\MaintainAcademicStructure;
use App\Modules\Academic\Models\AcademicPeriod;
use App\Modules\Academic\Models\Program;
use App\Modules\Identity\Models\Person;
use App\Modules\Identity\Models\UserAccount;
use App\Support\Identifiers\RandomIdentifier;
use Carbon\CarbonImmutable;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Hash;
use Tests\Concerns\BuildsActors;
use Tests\TestCase;

/**
 * AC15: the teacher-assignment lifecycle over the employee console —
 * end on an explicit date with reason, extend a dated assignment,
 * hand over to a successor in one audited step — plus the decided
 * post-end read tier (in-term viewing continues, post-term denied)
 * and governed refusals. The assessment/attendance/class authorities
 * are untouched: the viewer rule never grants mutation authority.
 */
final class TeacherAssignmentLifecycleConsoleTest extends TestCase
{
    use BuildsActors;

    private string $versionId;

    private string $periodId;

    private string $pastPeriodId;

    protected function setUp(): void
    {
        parent::setUp();

        $officer = $this->academicOfficer();
        $program = app(MaintainAcademicStructure::class)->defineProgram($officer, 'IELTS Preparation', 'tal-prog');
        $version = app(MaintainAcademicStructure::class)->publishVersion($officer, Program::query()->findOrFail($program['program_id']), 'assignment rules', 'tal-ver');
        $this->versionId = $version['version_id'];
        $period = app(MaintainAcademicStructure::class)->definePeriod($officer, 'Fall 2026', new CarbonImmutable('2026-09-01'), new CarbonImmutable('2026-12-18'), 'tal-period');
        app(MaintainAcademicStructure::class)->transitionPeriod($officer, AcademicPeriod::query()->findOrFail($period['period_id']), 'published', 'tal-period-pub');
        $this->periodId = $period['period_id'];
        $past = app(MaintainAcademicStructure::class)->definePeriod($officer, 'Spring 2020', new CarbonImmutable('2020-01-06'), new CarbonImmutable('2020-05-29'), 'tal-past');
        app(MaintainAcademicStructure::class)->transitionPeriod($officer, AcademicPeriod::query()->findOrFail($past['period_id']), 'published', 'tal-past-pub');
        $this->pastPeriodId = $past['period_id'];
    }

    /** @return array{0: Person, 1: UserAccount} */
    private function makeEmployee(string $personId, array $capabilities, string $username): array
    {
        $person = $this->personWithAuthority($personId, $capabilities);
        $account = UserAccount::query()->create([
            'id' => RandomIdentifier::new(),
            'person_id' => $person->id,
            'username' => $username,
            'password_hash' => Hash::make('tal-password-1'),
            'account_state' => UserAccount::STATE_ACTIVE,
        ]);

        return [$person, $account];
    }

    private function signIn(string $username): void
    {
        $this->post('/login', ['username' => $username, 'password' => 'tal-password-1'])->assertRedirect('/');
        $this->assertAuthenticated();
    }

    private function signOut(): void
    {
        $this->post('/logout')->assertRedirect('/login');
        $this->assertGuest();
    }

    private function prefix(): string
    {
        return DB::connection()->getTablePrefix();
    }

    /**
     * Define a class over HTTP and drive it to active with the given
     * teacher, returning class and assignment ids.
     *
     * @return array{class_id: string, assignment_id: string}
     */
    private function activeClass(string $suffix, string $teacherPersonId, string $periodId, string $effectiveFrom = '2026-09-01'): array
    {
        $knownIds = DB::table($this->prefix().'classes')->pluck('id')->all();
        $this->post('/academic/classes', [
            'program_version_id' => $this->versionId,
            'period_id' => $periodId,
            'capacity' => 2,
        ])->assertRedirect('/academic');
        /** @var string $classId */
        $classId = DB::table($this->prefix().'classes')->whereNotIn('id', $knownIds)->value('id');
        $this->assertNotNull($classId);

        $this->personWithAuthority($teacherPersonId, []);
        $knownAssignments = DB::table($this->prefix().'teacher_assignments')->pluck('id')->all();
        $this->post('/academic/teacher-assignments', [
            'class_id' => $classId,
            'teacher_person_id' => $teacherPersonId,
            'effective_from' => $effectiveFrom,
        ])->assertRedirect('/academic');
        /** @var string $assignmentId */
        $assignmentId = DB::table($this->prefix().'teacher_assignments')->whereNotIn('id', $knownAssignments)->value('id');
        $this->assertNotNull($assignmentId);

        $this->post('/academic/classes/'.$classId.'/transition', ['to_state' => 'published'])->assertRedirect('/academic');
        $this->post('/academic/classes/'.$classId.'/transition', ['to_state' => 'active'])->assertRedirect('/academic');

        return ['class_id' => $classId, 'assignment_id' => $assignmentId];
    }

    public function test_end_extend_and_handover_with_read_continuity(): void
    {
        $this->makeEmployee('tal-mgmt-1', ['academic.schedule'], 'assignment-manager');
        $this->makeEmployee('tal-teacher-a1', [], 'teacher-a');
        $this->makeEmployee('tal-teacher-b1', [], 'teacher-b');

        $this->signIn('assignment-manager');
        $setup = $this->activeClass('arc', 'tal-teacher-a1', $this->periodId);
        $classId = $setup['class_id'];
        $assignmentId = $setup['assignment_id'];
        $this->signOut();

        // The open-assigned teacher opens the gradesheet by identity.
        $this->signIn('teacher-a');
        $this->get('/academic/gradesheets/'.$classId)->assertOk()->assertSee('Class gradesheet');
        $this->signOut();

        // Handover ends the open row and opens the successor in one
        // audited step; the audit links both rows. The class stays
        // active throughout.
        $this->signIn('assignment-manager');
        $this->post('/academic/teacher-assignments/'.$assignmentId.'/handover', [
            'successor_teacher_person_id' => 'tal-teacher-b1',
            'handover_on' => '2026-09-05',
            'reason' => 'handover approved by academic management',
        ])->assertRedirect('/academic');
        $this->assertDatabaseHas($this->prefix().'teacher_assignments', [
            'id' => $assignmentId, 'effective_to' => '2026-09-05',
        ]);
        $successorId = DB::table($this->prefix().'teacher_assignments')
            ->where('class_id', $classId)->where('teacher_person_id', 'tal-teacher-b1')->value('id');
        $this->assertNotNull($successorId);
        $this->assertDatabaseHas($this->prefix().'teacher_assignments', [
            'id' => $successorId, 'effective_from' => '2026-09-05', 'effective_to' => null,
        ]);
        $this->assertDatabaseHas($this->prefix().'audit_events', [
            'operation' => 'academic.teacher.handover',
            'target_type' => 'teacher_assignment',
            'target_id' => $successorId,
        ]);
        $this->assertDatabaseHas($this->prefix().'classes', ['id' => $classId, 'lifecycle_state' => 'active']);
        $this->signOut();

        // Ended but in-term, the outgoing teacher keeps read access;
        // the open successor reads by identity.
        $this->signIn('teacher-a');
        $this->get('/academic/gradesheets/'.$classId)->assertOk()->assertSee('Class gradesheet');
        $this->signOut();
        $this->signIn('teacher-b');
        $this->get('/academic/gradesheets/'.$classId)->assertOk()->assertSee('Class gradesheet');
        $this->signOut();

        // Management ends the successor outright, then extends the
        // dated row with a new reason.
        $this->signIn('assignment-manager');
        $this->post('/academic/teacher-assignments/'.$successorId.'/end', [
            'effective_to' => '2026-09-10',
            'reason' => 'cover finished',
        ])->assertRedirect('/academic');
        $this->assertDatabaseHas($this->prefix().'teacher_assignments', [
            'id' => $successorId, 'effective_to' => '2026-09-10',
        ]);
        $this->post('/academic/teacher-assignments/'.$successorId.'/extend', [
            'effective_to' => '2026-10-01',
            'reason' => 'cover extended by management',
        ])->assertRedirect('/academic');
        $this->assertDatabaseHas($this->prefix().'teacher_assignments', [
            'id' => $successorId, 'effective_to' => '2026-10-01',
        ]);
        $this->signOut();

        // Both ended teachers still read in-term; the gradesheet shows
        // the handover lineage.
        $this->signIn('teacher-a');
        $this->get('/academic/gradesheets/'.$classId)->assertOk()->assertSee('(ended)');
        $this->signOut();
        $this->signIn('teacher-b');
        $this->get('/academic/gradesheets/'.$classId)->assertOk()->assertSee('(ended)');
        $this->signOut();
    }

    public function test_assignment_lifecycle_refusals_are_governed(): void
    {
        $this->makeEmployee('tal-mgmt-2', ['academic.schedule'], 'refusal-manager');
        $this->makeEmployee('tal-plain-2', [], 'refusal-stranger');

        $this->signIn('refusal-manager');
        $setup = $this->activeClass('ref', 'tal-teacher-c2', $this->periodId);
        $assignmentId = $setup['assignment_id'];

        // An end date on or before the start is refused.
        $this->post('/academic/teacher-assignments/'.$assignmentId.'/end', [
            'effective_to' => '2026-09-01',
            'reason' => 'same-day end attempt',
        ], ['referer' => 'http://localhost/academic'])
            ->assertRedirect('/academic')
            ->assertSessionHas('error_code', 'academic.assignment_period');

        $this->post('/academic/teacher-assignments/'.$assignmentId.'/end', [
            'effective_to' => '2026-09-04',
            'reason' => 'resigned',
        ])->assertRedirect('/academic');

        // A dated assignment cannot be ended again…
        $this->post('/academic/teacher-assignments/'.$assignmentId.'/end', [
            'effective_to' => '2026-10-01',
            'reason' => 'second end attempt',
        ], ['referer' => 'http://localhost/academic'])
            ->assertRedirect('/academic')
            ->assertSessionHas('error_code', 'academic.assignment_not_open');

        // …and an extension must move the date later.
        $this->post('/academic/teacher-assignments/'.$assignmentId.'/extend', [
            'effective_to' => '2026-09-04',
            'reason' => 'non-later extension attempt',
        ], ['referer' => 'http://localhost/academic'])
            ->assertRedirect('/academic')
            ->assertSessionHas('error_code', 'academic.assignment_period');
        $this->assertDatabaseHas($this->prefix().'teacher_assignments', [
            'id' => $assignmentId, 'effective_to' => '2026-09-04',
        ]);

        // An open assignment cannot be extended; it has no end date.
        $this->personWithAuthority('tal-teacher-d2', []);
        $knownAssignments = DB::table($this->prefix().'teacher_assignments')->pluck('id')->all();
        $this->post('/academic/teacher-assignments', [
            'class_id' => $setup['class_id'],
            'teacher_person_id' => 'tal-teacher-d2',
            'effective_from' => '2026-09-01',
        ])->assertRedirect('/academic');
        $openId = DB::table($this->prefix().'teacher_assignments')->whereNotIn('id', $knownAssignments)->value('id');
        $this->post('/academic/teacher-assignments/'.$openId.'/extend', [
            'effective_to' => '2026-12-01',
            'reason' => 'extension of an open assignment',
        ], ['referer' => 'http://localhost/academic'])
            ->assertRedirect('/academic')
            ->assertSessionHas('error_code', 'academic.assignment_not_dated');

        // The successor must not already hold an open assignment.
        $this->post('/academic/teacher-assignments/'.$openId.'/handover', [
            'successor_teacher_person_id' => 'tal-teacher-c2',
            'handover_on' => '2026-09-05',
            'reason' => 'handover to the dated teacher',
        ])->assertRedirect('/academic');

        $this->personWithAuthority('tal-teacher-e2', []);
        $knownAssignments = DB::table($this->prefix().'teacher_assignments')->pluck('id')->all();
        $this->post('/academic/teacher-assignments', [
            'class_id' => $setup['class_id'],
            'teacher_person_id' => 'tal-teacher-e2',
            'effective_from' => '2026-09-01',
        ])->assertRedirect('/academic');
        $thirdId = DB::table($this->prefix().'teacher_assignments')->whereNotIn('id', $knownAssignments)->value('id');
        // tal-teacher-c2 now holds the open handover successor row.
        $this->post('/academic/teacher-assignments/'.$thirdId.'/handover', [
            'successor_teacher_person_id' => 'tal-teacher-c2',
            'handover_on' => '2026-09-06',
            'reason' => 'duplicate successor attempt',
        ], ['referer' => 'http://localhost/academic'])
            ->assertRedirect('/academic')
            ->assertSessionHas('error_code', 'academic.teacher_duplicate');
        $this->signOut();

        // Without the schedule capability, lifecycle verbs are refused.
        $this->signIn('refusal-stranger');
        $this->post('/academic/teacher-assignments/'.$thirdId.'/end', [
            'effective_to' => '2026-10-01',
            'reason' => 'no authority behind this',
        ], ['referer' => 'http://localhost/academic'])
            ->assertRedirect('/academic')
            ->assertSessionHas('error_code', 'academic.schedule_denied');
        $this->assertDatabaseHas($this->prefix().'teacher_assignments', [
            'id' => $thirdId, 'effective_to' => null,
        ]);
    }

    public function test_ended_assignment_loses_read_access_after_term_end(): void
    {
        $this->makeEmployee('tal-mgmt-3', ['academic.schedule'], 'past-manager');
        $this->makeEmployee('tal-teacher-f3', [], 'past-teacher');

        $this->signIn('past-manager');
        $setup = $this->activeClass('past', 'tal-teacher-f3', $this->pastPeriodId, '2020-01-06');
        $this->post('/academic/teacher-assignments/'.$setup['assignment_id'].'/end', [
            'effective_to' => '2020-03-01',
            'reason' => 'term cover finished',
        ])->assertRedirect('/academic');
        $this->signOut();

        $this->signIn('past-teacher');
        $this->get('/academic')->assertOk()->assertSee('No classes are open to you');
        $this->get('/academic/gradesheets/'.$setup['class_id'])
            ->assertRedirect('/')
            ->assertSessionHas('error_code', 'academic.gradesheet_denied');
        $this->assertDatabaseHas($this->prefix().'audit_events', [
            'actor_id' => 'tal-teacher-f3',
            'operation' => 'academic.gradesheet.view.denied',
            'target_type' => 'class',
            'target_id' => $setup['class_id'],
        ]);
    }
}
