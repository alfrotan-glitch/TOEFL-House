<?php

declare(strict_types=1);

namespace Tests\Feature\Console;

use App\Modules\Academic\Commands\MaintainAcademicStructure;
use App\Modules\Academic\Commands\MaintainClass;
use App\Modules\Academic\Models\AcademicPeriod;
use App\Modules\Academic\Models\ClassModel;
use App\Modules\Academic\Models\Program;
use App\Modules\Identity\Models\UserAccount;
use App\Modules\Organization\Models\Branch;
use App\Support\Identifiers\RandomIdentifier;
use Carbon\CarbonImmutable;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Hash;
use Tests\Concerns\BuildsActors;
use Tests\TestCase;

/**
 * AC10: the certified room / class-section / timetable surface is
 * operational through the employee console. Room definition, lifecycle,
 * and resizing; section definition and lifecycle; room/section-aware
 * session scheduling; and the branch×day timetable are exercised over
 * the real HTTP surface; domain guards refuse unsafe operations with
 * the governed error shape instead of a state change.
 */
final class RoomsSectionsTimetableConsoleTest extends TestCase
{
    use BuildsActors;

    private string $branchId;

    private string $classId;

    private string $secondClassId;

    private string $tomorrow;

    protected function setUp(): void
    {
        parent::setUp();

        $officer = $this->academicOfficer('rst-officer-domain');
        $structure = app(MaintainAcademicStructure::class);

        $this->branchId = Branch::query()->create([
            'id' => RandomIdentifier::new(),
            'name' => 'Timetable Branch '.substr(md5(RandomIdentifier::new()), 0, 8),
            'lifecycle_state' => 'active',
        ])->id;

        $program = $structure->defineProgram($officer, 'Console Intensive', 'rst-prog');
        $version = $structure->publishVersion($officer, Program::query()->findOrFail($program['program_id']), 'Console v1', 'rst-ver');
        $period = $structure->definePeriod($officer, 'Console Term', new CarbonImmutable('2026-09-01'), new CarbonImmutable('2026-12-30'), 'rst-period');
        $structure->transitionPeriod($officer, AcademicPeriod::query()->findOrFail($period['period_id']), 'published', 'rst-period-pub');

        $maintainClass = app(MaintainClass::class);
        $this->personWithAuthority('rst-teacher-1', []);
        foreach (['rst-class' => 'classId', 'rst-class-2' => 'secondClassId'] as $key => $property) {
            $class = $maintainClass->defineClass($officer, $version['version_id'], $period['period_id'], 4, $key);
            $this->{$property} = $class['class_id'];
            $maintainClass->assignTeacher($officer, ClassModel::query()->findOrFail($class['class_id']), 'rst-teacher-1', new CarbonImmutable('2026-09-01'), null, $key.'-ta');
            $maintainClass->transition($officer, ClassModel::query()->findOrFail($class['class_id']), 'published', $key.'-pub');
            $maintainClass->transition($officer, ClassModel::query()->findOrFail($class['class_id']), 'active', $key.'-act');
        }

        $this->tomorrow = CarbonImmutable::now()->addDay()->toDateString();

        $this->makeEmployee('rst-officer-1', ['academic.structure', 'academic.schedule'], 'room-officer');
        $this->makeEmployee('rst-scheduler-1', ['academic.schedule'], 'scheduler');
        $this->makeEmployee('rst-stranger-1', [], 'stranger');
    }

    private function makeEmployee(string $personId, array $capabilities, string $username): void
    {
        $person = $this->personWithAuthority($personId, $capabilities);
        UserAccount::query()->create([
            'id' => RandomIdentifier::new(),
            'person_id' => $person->id,
            'username' => $username,
            'password_hash' => Hash::make('rst-password-1'),
            'account_state' => UserAccount::STATE_ACTIVE,
        ]);
    }

    private function signIn(string $username): void
    {
        $this->post('/login', ['username' => $username, 'password' => 'rst-password-1'])->assertRedirect('/');
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

    /** @return array{post: string, referer: array{referer: string}} */
    private function onSessionsPage(): array
    {
        return ['post' => '/academic/sessions', 'referer' => ['referer' => 'http://localhost/academic/sessions']];
    }

    private function defineRoomViaConsole(string $code, string $name = 'Room'): string
    {
        $this->post('/academic/rooms', [
            'branch_id' => $this->branchId,
            'name' => $name.' '.$code,
            'code' => $code,
            'capacity' => 20,
            'room_type' => 'classroom',
        ])->assertRedirect('/academic/sessions');

        /** @var string $roomId */
        $roomId = DB::table($this->prefix().'academic_rooms')->where('code', $code)->value('id');
        $this->assertNotNull($roomId);

        return $roomId;
    }

    private function defineSectionViaConsole(string $classId, string $name): string
    {
        $this->post('/academic/sections', [
            'class_id' => $classId,
            'name' => $name,
            'capacity' => 10,
        ])->assertRedirect('/academic/sessions');

        /** @var string $sectionId */
        $sectionId = DB::table($this->prefix().'class_sections')->where('class_id', $classId)->where('name', $name)->value('id');
        $this->assertNotNull($sectionId);

        return $sectionId;
    }

    public function test_room_lifecycle_through_console(): void
    {
        $this->signIn('room-officer');
        $this->get('/academic/sessions')->assertOk()->assertSee('Rooms');

        $roomId = $this->defineRoomViaConsole('R-01');
        $this->assertDatabaseHas($this->prefix().'academic_rooms', ['id' => $roomId, 'lifecycle_state' => 'available', 'capacity' => 20]);

        // A duplicate code within the branch is refused with the governed error.
        $this->post('/academic/rooms', [
            'branch_id' => $this->branchId,
            'name' => 'Room R-01 duplicate',
            'code' => 'R-01',
            'capacity' => 20,
            'room_type' => 'lab',
        ], $this->onSessionsPage()['referer'])
            ->assertRedirect('/academic/sessions')
            ->assertSessionHas('error_code', 'academic.room_code_exists');

        $this->post('/academic/rooms/'.$roomId.'/transition', ['to_state' => 'maintenance'])->assertRedirect('/academic/sessions');
        $this->assertDatabaseHas($this->prefix().'academic_rooms', ['id' => $roomId, 'lifecycle_state' => 'maintenance']);

        $this->post('/academic/rooms/'.$roomId.'/transition', ['to_state' => 'available'])->assertRedirect('/academic/sessions');
        $this->post('/academic/rooms/'.$roomId.'/resize', ['capacity' => 30])->assertRedirect('/academic/sessions');
        $this->assertDatabaseHas($this->prefix().'academic_rooms', ['id' => $roomId, 'capacity' => 30]);

        // Resizing to the current capacity is refused: no silent no-op.
        $this->post('/academic/rooms/'.$roomId.'/resize', ['capacity' => 30], $this->onSessionsPage()['referer'])
            ->assertRedirect('/academic/sessions')
            ->assertSessionHas('error_code', 'academic.room_capacity_unchanged');

        $this->post('/academic/rooms/'.$roomId.'/transition', ['to_state' => 'retired'])->assertRedirect('/academic/sessions');
        $this->assertDatabaseHas($this->prefix().'academic_rooms', ['id' => $roomId, 'lifecycle_state' => 'retired']);
        $this->signOut();
    }

    public function test_section_lifecycle_scheduling_and_timetable_through_console(): void
    {
        $this->signIn('room-officer');

        $roomId = $this->defineRoomViaConsole('R-02');
        $sectionId = $this->defineSectionViaConsole($this->classId, 'Alpha');
        $this->assertDatabaseHas($this->prefix().'class_sections', ['id' => $sectionId, 'lifecycle_state' => 'planned']);

        // A duplicate section name within the class is refused.
        $this->post('/academic/sections', [
            'class_id' => $this->classId,
            'name' => 'Alpha',
            'capacity' => 10,
        ], $this->onSessionsPage()['referer'])
            ->assertRedirect('/academic/sessions')
            ->assertSessionHas('error_code', 'academic.section_name_exists');

        $this->post('/academic/sections/'.$sectionId.'/transition', ['to_state' => 'open'])->assertRedirect('/academic/sessions');

        // Schedule tomorrow's session with the room and the section.
        $this->post('/academic/sessions', [
            'class_id' => $this->classId,
            'scheduled_on' => $this->tomorrow,
            'starts_at' => '09:00',
            'ends_at' => '10:30',
            'room_id' => $roomId,
            'section_id' => $sectionId,
        ])->assertRedirect('/academic/sessions');
        $this->assertDatabaseHas($this->prefix().'class_sessions', [
            'class_id' => $this->classId, 'room_id' => $roomId, 'section_id' => $sectionId, 'scheduled_on' => $this->tomorrow,
        ]);

        // The booking is visible on the session rows and the branch day timetable.
        $this->get('/academic/sessions')->assertOk()->assertSee('R-02')->assertSee('Alpha');
        $this->get('/academic/sessions?timetable_branch_id='.$this->branchId.'&timetable_day='.$this->tomorrow)
            ->assertOk()
            ->assertSee('R-02')
            ->assertSee('09:00');

        // The room cannot leave service and the section cannot close while
        // the future session references them.
        $this->post('/academic/rooms/'.$roomId.'/transition', ['to_state' => 'maintenance'], $this->onSessionsPage()['referer'])
            ->assertRedirect('/academic/sessions')
            ->assertSessionHas('error_code', 'academic.room_has_future_sessions');
        $this->post('/academic/sections/'.$sectionId.'/transition', ['to_state' => 'closed'], $this->onSessionsPage()['referer'])
            ->assertRedirect('/academic/sessions')
            ->assertSessionHas('error_code', 'academic.section_has_future_sessions');
        $this->assertDatabaseHas($this->prefix().'academic_rooms', ['id' => $roomId, 'lifecycle_state' => 'available']);
        $this->assertDatabaseHas($this->prefix().'class_sections', ['id' => $sectionId, 'lifecycle_state' => 'open']);
        $this->signOut();
    }

    public function test_scheduling_guards_through_console(): void
    {
        $this->signIn('room-officer');
        $referer = $this->onSessionsPage()['referer'];

        $roomId = $this->defineRoomViaConsole('R-03');
        $plannedSectionId = $this->defineSectionViaConsole($this->classId, 'Planned');
        $otherSectionId = $this->defineSectionViaConsole($this->secondClassId, 'B');
        $this->post('/academic/sections/'.$otherSectionId.'/transition', ['to_state' => 'open'])->assertRedirect('/academic/sessions');

        // A section of another class is refused for this class.
        $this->post('/academic/sessions', [
            'class_id' => $this->classId,
            'scheduled_on' => $this->tomorrow,
            'starts_at' => '09:00',
            'ends_at' => '10:30',
            'section_id' => $otherSectionId,
        ], $referer)
            ->assertRedirect('/academic/sessions')
            ->assertSessionHas('error_code', 'academic.session_section_class_mismatch');

        // A section that is not open is refused.
        $this->post('/academic/sessions', [
            'class_id' => $this->classId,
            'scheduled_on' => $this->tomorrow,
            'starts_at' => '09:00',
            'ends_at' => '10:30',
            'section_id' => $plannedSectionId,
        ], $referer)
            ->assertRedirect('/academic/sessions')
            ->assertSessionHas('error_code', 'academic.session_section_not_open');

        // A room that is not available is refused.
        $this->post('/academic/rooms/'.$roomId.'/transition', ['to_state' => 'maintenance'])->assertRedirect('/academic/sessions');
        $this->post('/academic/sessions', [
            'class_id' => $this->classId,
            'scheduled_on' => $this->tomorrow,
            'starts_at' => '09:00',
            'ends_at' => '10:30',
            'room_id' => $roomId,
        ], $referer)
            ->assertRedirect('/academic/sessions')
            ->assertSessionHas('error_code', 'academic.session_room_not_available');

        $this->assertSame(0, DB::table($this->prefix().'class_sessions')->where('scheduled_on', $this->tomorrow)->count());
        $this->signOut();
    }

    public function test_room_and_scheduling_capabilities_are_denied_governed(): void
    {
        // The scheduler holds academic.schedule but not academic.structure:
        // rooms stay out of reach, scheduling stays open.
        $this->signIn('scheduler');
        $this->post('/academic/rooms', [
            'branch_id' => $this->branchId,
            'name' => 'Scheduler Room',
            'code' => 'R-99',
            'capacity' => 10,
            'room_type' => 'classroom',
        ], $this->onSessionsPage()['referer'])
            ->assertRedirect('/academic/sessions')
            ->assertSessionHas('error_code', 'academic.structure_denied');
        $this->assertSame(0, DB::table($this->prefix().'academic_rooms')->where('code', 'R-99')->count());
        $this->signOut();

        // A stranger holds neither capability.
        $this->signIn('stranger');
        $this->post('/academic/sections', [
            'class_id' => $this->classId,
            'name' => 'Intruder',
            'capacity' => 10,
        ], $this->onSessionsPage()['referer'])
            ->assertRedirect('/academic/sessions')
            ->assertSessionHas('error_code', 'academic.schedule_denied');
        $this->assertSame(0, DB::table($this->prefix().'class_sections')->where('name', 'Intruder')->count());
        $this->signOut();
    }
}
