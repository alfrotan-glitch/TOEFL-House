<?php

declare(strict_types=1);

namespace Tests\Feature\Academic;

use App\Modules\Academic\Commands\MaintainAcademicStructure;
use App\Modules\Academic\Commands\MaintainClass;
use App\Modules\Academic\Commands\MaintainRoom;
use App\Modules\Academic\Models\AcademicPeriod;
use App\Modules\Academic\Models\AcademicRoom;
use App\Modules\Academic\Models\ClassModel;
use App\Modules\Academic\Models\ClassSection;
use App\Modules\Academic\Models\ClassSession;
use App\Modules\Academic\Models\Program;
use App\Modules\Academic\Queries\TimetableQuery;
use App\Modules\Organization\Models\Branch;
use App\Support\Errors\BusinessRejection;
use App\Support\Identifiers\RandomIdentifier;
use Carbon\CarbonImmutable;
use Illuminate\Database\QueryException;
use Tests\Concerns\BuildsActors;
use Tests\TestCase;

final class AcademicRoomsAndSectionsFeatureTest extends TestCase
{
    use BuildsActors;

    private string $branchId;

    private string $classId;

    private string $teacherPersonId = 'sched-teacher-1';

    protected function setUp(): void
    {
        parent::setUp();
        $this->personWithAuthority($this->teacherPersonId, []);
        $structure = app(MaintainAcademicStructure::class);
        $officer = $this->academicOfficer('sched-officer-setup');

        $this->branchId = Branch::query()->create([
            'id' => RandomIdentifier::new(),
            'name' => 'Scheduling Branch '.substr(md5(RandomIdentifier::new()), 0, 8),
            'lifecycle_state' => 'active',
        ])->id;

        $program = $structure->defineProgram($officer, 'Scheduling Program', 'sched-prog');
        $version = $structure->publishVersion($officer, Program::query()->findOrFail($program['program_id']), 'Scheduling v1', 'sched-ver');
        $period = $structure->definePeriod($officer, 'Scheduling Term', new CarbonImmutable('2026-09-01'), new CarbonImmutable('2026-12-31'), 'sched-period');
        $structure->transitionPeriod($officer, AcademicPeriod::query()->findOrFail($period['period_id']), 'published', 'sched-period-pub');

        $this->classId = app(MaintainClass::class)->defineClass($officer, $version['version_id'], $period['period_id'], 20, 'sched-class')['class_id'];
        app(MaintainClass::class)->assignTeacher($officer, ClassModel::query()->findOrFail($this->classId), $this->teacherPersonId, new CarbonImmutable('2026-09-01'), null, 'sched-class-teacher');
        app(MaintainClass::class)->transition($officer, ClassModel::query()->findOrFail($this->classId), 'published', 'sched-class-pub');
        app(MaintainClass::class)->transition($officer, ClassModel::query()->findOrFail($this->classId), 'active', 'sched-class-active');
    }

    public function test_room_lifecycle_resize_and_future_session_retire_guard(): void
    {
        $officer = $this->academicOfficer('sched-officer-room');
        $maintainRoom = app(MaintainRoom::class);

        $room = $maintainRoom->defineRoom($officer, $this->branchId, 'Room One', 'R-01', 20, 'classroom', 'room-key-1');
        $this->assertDatabaseHas('academic_rooms', ['id' => $room['room_id'], 'capacity' => 20, 'lifecycle_state' => 'available']);

        $maintainRoom->transition($officer, AcademicRoom::query()->findOrFail($room['room_id']), 'maintenance', 'room-key-2');
        $this->assertSame('maintenance', AcademicRoom::query()->findOrFail($room['room_id'])->lifecycle_state);
        $maintainRoom->transition($officer, AcademicRoom::query()->findOrFail($room['room_id']), 'available', 'room-key-3');

        $resized = $maintainRoom->resize($officer, AcademicRoom::query()->findOrFail($room['room_id']), 30, 'room-key-4');
        $this->assertSame(30, $resized['capacity']);

        app(MaintainClass::class)->scheduleSession(
            $officer,
            ClassModel::query()->findOrFail($this->classId),
            new CarbonImmutable('2026-09-10'),
            '09:00:00',
            '11:00:00',
            'sched-session-room',
            null,
            $room['room_id'],
            null,
        );

        try {
            $maintainRoom->transition($officer, AcademicRoom::query()->findOrFail($room['room_id']), 'retired', 'room-key-5');
            $this->fail('a room with future sessions cannot be retired');
        } catch (BusinessRejection $rejection) {
            $this->assertSame('academic.room_has_future_sessions', $rejection->errorCode());
        }

        $this->assertDatabaseHas('audit_events', ['operation' => 'academic.room.define']);
        $this->assertDatabaseHas('audit_events', ['operation' => 'academic.room.transition.maintenance']);
    }

    public function test_section_lifecycle_and_timetable_scheduling(): void
    {
        $officer = $this->academicOfficer('sched-officer-section');
        $maintainClass = app(MaintainClass::class);
        $room = app(MaintainRoom::class)->defineRoom($officer, $this->branchId, 'Room Two', 'R-02', 20, 'classroom', 'room-key-10');
        $section = $maintainClass->defineSection($officer, ClassModel::query()->findOrFail($this->classId), 'A', 10, 'section-key-1');
        $maintainClass->transitionSection($officer, ClassSection::query()->findOrFail($section['section_id']), 'open', 'section-key-2');

        $session = $maintainClass->scheduleSession(
            $officer,
            ClassModel::query()->findOrFail($this->classId),
            new CarbonImmutable('2026-09-11'),
            '09:00:00',
            '11:00:00',
            'section-session-1',
            null,
            $room['room_id'],
            $section['section_id'],
        );
        $this->assertDatabaseHas('class_sessions', ['id' => $session['session_id'], 'room_id' => $room['room_id'], 'section_id' => $section['section_id']]);

        // a non-overlapping class session in the same section is allowed
        $maintainClass->scheduleSession(
            $officer,
            ClassModel::query()->findOrFail($this->classId),
            new CarbonImmutable('2026-09-11'),
            '12:00:00',
            '13:30:00',
            'section-session-2',
            null,
            $room['room_id'],
            $section['section_id'],
        );

        try {
            $maintainClass->scheduleSession(
                $officer,
                ClassModel::query()->findOrFail($this->classId),
                new CarbonImmutable('2026-09-11'),
                '10:30:00',
                '12:30:00',
                'section-session-overlap',
                null,
                $room['room_id'],
                $section['section_id'],
            );
            $this->fail('overlapping section sessions must be rejected');
        } catch (QueryException) {
            $this->assertSame(2, ClassSession::query()->where('section_id', $section['section_id'])->where('scheduled_on', '2026-09-11')->count());
        }

        $timetable = (new TimetableQuery)->forClass($this->classId, new CarbonImmutable('2026-09-11'));
        $this->assertSame('A', $timetable['sections'][0]['name']);
        $this->assertCount(2, $timetable['sessions']);
        $this->assertSame('R-02', $timetable['sessions'][0]['room']);

        try {
            $maintainClass->transitionSection($officer, ClassSection::query()->findOrFail($section['section_id']), 'closed', 'section-key-3');
            $this->fail('a section with future sessions cannot close');
        } catch (BusinessRejection $rejection) {
            $this->assertSame('academic.section_has_future_sessions', $rejection->errorCode());
        }

        $this->assertDatabaseHas('audit_events', ['operation' => 'academic.section.define']);
        $this->assertDatabaseHas('audit_events', ['operation' => 'academic.section.transition.open']);
    }

    public function test_schedule_rejects_non_available_room_and_non_open_section(): void
    {
        $officer = $this->academicOfficer('sched-officer-guard');
        $maintainClass = app(MaintainClass::class);
        $room = app(MaintainRoom::class)->defineRoom($officer, $this->branchId, 'Room Three', 'R-03', 20, 'classroom', 'room-key-20');
        app(MaintainRoom::class)->transition($officer, AcademicRoom::query()->findOrFail($room['room_id']), 'maintenance', 'room-key-21');

        try {
            $maintainClass->scheduleSession(
                $officer,
                ClassModel::query()->findOrFail($this->classId),
                new CarbonImmutable('2026-09-12'),
                '09:00:00',
                '11:00:00',
                'guard-session-room',
                null,
                $room['room_id'],
                null,
            );
            $this->fail('a non-available room must reject scheduling');
        } catch (BusinessRejection $rejection) {
            $this->assertSame('academic.session_room_not_available', $rejection->errorCode());
        }

        $section = $maintainClass->defineSection($officer, ClassModel::query()->findOrFail($this->classId), 'B', 10, 'section-key-20');
        try {
            $maintainClass->scheduleSession(
                $officer,
                ClassModel::query()->findOrFail($this->classId),
                new CarbonImmutable('2026-09-12'),
                '09:00:00',
                '11:00:00',
                'guard-session-section',
                null,
                null,
                $section['section_id'],
            );
            $this->fail('a non-open section must reject scheduling');
        } catch (BusinessRejection $rejection) {
            $this->assertSame('academic.session_section_not_open', $rejection->errorCode());
        }
    }
}
