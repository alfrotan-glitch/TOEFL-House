<?php

declare(strict_types=1);

namespace Tests\Feature\Academic;

use App\Modules\Academic\Commands\MaintainAcademicStructure;
use App\Modules\Academic\Commands\MaintainClass;
use App\Modules\Academic\Commands\MaintainSkill;
use App\Modules\Academic\Models\AcademicPeriod;
use App\Modules\Academic\Models\ClassModel;
use App\Modules\Academic\Models\Program;
use App\Modules\Academic\Models\Skill;
use App\Modules\Academic\Models\TeacherAssignment;
use App\Modules\Audit\Models\AuditEvent;
use App\Support\Errors\AuthorizationDenied;
use App\Support\Errors\BusinessRejection;
use Carbon\CarbonImmutable;
use Illuminate\Database\QueryException;
use Illuminate\Support\Facades\DB;
use Tests\Concerns\BuildsActors;
use Tests\TestCase;

/**
 * Skill catalog boundary: registration and controlled retirement of the
 * teaching skills, multi-skill teaching assignments and skill-attributed
 * sessions — with the schema guards against deletion, retirement edits and
 * free-text drift.
 */
final class SkillFeatureTest extends TestCase
{
    use BuildsActors;

    private string $skillRegistrarId = 'p16-skill-reg-1';

    /** @return array<string, string> */
    private function registerInitialSkills(): array
    {
        $registrar = $this->grantedActor($this->skillRegistrarId, ['academic.skill']);
        $command = app(MaintainSkill::class);
        $ids = [];
        foreach (['speaking_listening' => 'Speaking & Listening', 'writing_grammar' => 'Writing & Grammar', 'reading_vocabulary' => 'Reading & Vocabulary'] as $key => $name) {
            $ids[$key] = $command->register($registrar, $key, $name, 'p16-skill-'.$key)['skill_id'];
        }

        return $ids;
    }

    public function test_skill_catalog_registration_duplicate_rejection_and_audit(): void
    {
        $ids = $this->registerInitialSkills();
        $this->assertCount(3, $ids);
        $this->assertDatabaseHas('skills', ['key' => 'speaking_listening', 'lifecycle_state' => 'active']);

        $registrar = $this->grantedActor($this->skillRegistrarId, ['academic.skill']);
        try {
            app(MaintainSkill::class)->register($registrar, 'speaking_listening', 'Duplicate', 'p16-skill-dup');
            $this->fail('a duplicate skill key must be rejected');
        } catch (BusinessRejection $rejection) {
            $this->assertSame('academic.skill_duplicate', $rejection->errorCode());
        }

        $intruder = $this->actorWithoutAnyCapability('p16-skill-intruder');
        try {
            app(MaintainSkill::class)->register($intruder, 'cooking', 'Cooking', 'p16-skill-unauth');
            $this->fail('skill registration requires the academic.skill capability');
        } catch (AuthorizationDenied $denial) {
            $this->assertSame('academic.skill_denied', $denial->errorCode());
        }
        $this->assertSame(1, AuditEvent::query()->where('operation', 'academic.skill.register.denied')->where('actor_id', 'p16-skill-intruder')->count());
        $this->assertDatabaseMissing('skills', ['key' => 'cooking']);
    }

    public function test_skill_retirement_is_controlled_and_catalog_history_is_immutable(): void
    {
        $ids = $this->registerInitialSkills();
        $registrar = $this->grantedActor($this->skillRegistrarId, ['academic.skill']);
        $command = app(MaintainSkill::class);

        $command->retire($registrar, Skill::query()->findOrFail($ids['reading_vocabulary']), 'p16-skill-ret-1');
        $this->assertDatabaseHas('skills', ['id' => $ids['reading_vocabulary'], 'lifecycle_state' => 'retired']);

        try {
            $command->retire($registrar, Skill::query()->findOrFail($ids['reading_vocabulary']), 'p16-skill-ret-2');
            $this->fail('a retired skill cannot be retired again');
        } catch (BusinessRejection $rejection) {
            $this->assertSame('academic.skill_not_active', $rejection->errorCode());
        }

        try {
            DB::statement('UPDATE skills SET name = ? WHERE id = ?', ['renamed', $ids['reading_vocabulary']]);
            $this->fail('a retired skill is immutable');
        } catch (QueryException) {
            $this->addToAssertionCount(1);
        }

        try {
            DB::statement('UPDATE skills SET key = ? WHERE id = ?', ['hacked', $ids['speaking_listening']]);
            $this->fail('skill identity is immutable');
        } catch (QueryException) {
            $this->addToAssertionCount(1);
        }

        try {
            DB::statement('DELETE FROM skills WHERE id = ?', [$ids['speaking_listening']]);
            $this->fail('skills are never deleted');
        } catch (QueryException) {
            $this->addToAssertionCount(1);
        }
    }

    public function test_assignment_carries_multiple_skills_and_is_append_only(): void
    {
        $ids = $this->registerInitialSkills();
        $officer = $this->academicOfficer();
        $this->personWithAuthority('p16-teacher-1', []);

        $program = app(MaintainAcademicStructure::class)->defineProgram($officer, 'TOEFL Course', 'p16-prog-1');
        $version = app(MaintainAcademicStructure::class)->publishVersion($officer, Program::query()->findOrFail($program['program_id']), 'rules', 'p16-prog-2');
        $period = app(MaintainAcademicStructure::class)->definePeriod($officer, 'Fall 2026', new CarbonImmutable('2026-08-01'), new CarbonImmutable('2026-12-18'), 'p16-per-1');
        app(MaintainAcademicStructure::class)->transitionPeriod($officer, AcademicPeriod::query()->findOrFail($period['period_id']), 'published', 'p16-per-2');
        $class = app(MaintainClass::class)->defineClass($officer, $version['version_id'], $period['period_id'], 2, 'p16-class-1');
        $assignment = app(MaintainClass::class)->assignTeacher($officer, ClassModel::query()->findOrFail($class['class_id']), 'p16-teacher-1', new CarbonImmutable('2026-08-01'), null, 'p16-class-2');

        app(MaintainClass::class)->assignSkill($officer, TeacherAssignment::query()->findOrFail($assignment['assignment_id']), $ids['speaking_listening'], 'p16-skill-a1');
        app(MaintainClass::class)->assignSkill($officer, TeacherAssignment::query()->findOrFail($assignment['assignment_id']), $ids['writing_grammar'], 'p16-skill-a2');

        try {
            app(MaintainClass::class)->assignSkill($officer, TeacherAssignment::query()->findOrFail($assignment['assignment_id']), $ids['speaking_listening'], 'p16-skill-a3');
            $this->fail('the same skill cannot be attached twice to one assignment');
        } catch (BusinessRejection $rejection) {
            $this->assertSame('academic.assignment_skill_duplicate', $rejection->errorCode());
        }

        $unknownSkillId = '00000000-0000-4000-8000-00000000feed';
        try {
            app(MaintainClass::class)->assignSkill($officer, TeacherAssignment::query()->findOrFail($assignment['assignment_id']), $unknownSkillId, 'p16-skill-a4');
            $this->fail('an assignment skill must exist in the catalog');
        } catch (BusinessRejection $rejection) {
            $this->assertSame('academic.assignment_skill_unknown', $rejection->errorCode());
        }

        try {
            DB::statement('UPDATE teacher_assignment_skills SET skill_id = ? WHERE teacher_assignment_id = ?', [$ids['reading_vocabulary'], $assignment['assignment_id']]);
            $this->fail('assignment skills are append-only');
        } catch (QueryException) {
            $this->addToAssertionCount(1);
        }
        try {
            DB::statement('DELETE FROM teacher_assignment_skills WHERE teacher_assignment_id = ?', [$assignment['assignment_id']]);
            $this->fail('assignment skills cannot be deleted');
        } catch (QueryException) {
            $this->addToAssertionCount(1);
        }
    }

    public function test_sessions_carry_one_active_skill_and_retired_skills_are_not_schedulable(): void
    {
        $ids = $this->registerInitialSkills();
        $officer = $this->academicOfficer();
        $this->personWithAuthority('p16-teacher-2', []);

        $program = app(MaintainAcademicStructure::class)->defineProgram($officer, 'TOEFL Course', 'p16-prog-3');
        $version = app(MaintainAcademicStructure::class)->publishVersion($officer, Program::query()->findOrFail($program['program_id']), 'rules', 'p16-prog-4');
        $period = app(MaintainAcademicStructure::class)->definePeriod($officer, 'Fall 2026', new CarbonImmutable('2026-08-01'), new CarbonImmutable('2026-12-18'), 'p16-per-3');
        app(MaintainAcademicStructure::class)->transitionPeriod($officer, AcademicPeriod::query()->findOrFail($period['period_id']), 'published', 'p16-per-4');
        $class = app(MaintainClass::class)->defineClass($officer, $version['version_id'], $period['period_id'], 2, 'p16-class-3');
        $classId = $class['class_id'];
        app(MaintainClass::class)->assignTeacher($officer, ClassModel::query()->findOrFail($classId), 'p16-teacher-2', new CarbonImmutable('2026-08-01'), null, 'p16-class-4');
        app(MaintainClass::class)->transition($officer, ClassModel::query()->findOrFail($classId), 'published', 'p16-class-5');
        app(MaintainClass::class)->transition($officer, ClassModel::query()->findOrFail($classId), 'active', 'p16-class-6');

        $session = app(MaintainClass::class)->scheduleSession($officer, ClassModel::query()->findOrFail($classId), new CarbonImmutable('2026-08-05'), '09:00', '11:00', 'p16-ses-1', $ids['speaking_listening']);
        $this->assertDatabaseHas('class_sessions', ['id' => $session['session_id'], 'skill_id' => $ids['speaking_listening']]);

        try {
            app(MaintainClass::class)->scheduleSession($officer, ClassModel::query()->findOrFail($classId), new CarbonImmutable('2026-08-06'), '09:00', '11:00', 'p16-ses-2', '00000000-0000-4000-8000-00000000feed');
            $this->fail('an unknown skill cannot be scheduled');
        } catch (BusinessRejection $rejection) {
            $this->assertSame('academic.session_skill_unknown', $rejection->errorCode());
        }

        app(MaintainSkill::class)->retire($this->grantedActor($this->skillRegistrarId, ['academic.skill']), Skill::query()->findOrFail($ids['reading_vocabulary']), 'p16-skill-ret-3');
        try {
            app(MaintainClass::class)->scheduleSession($officer, ClassModel::query()->findOrFail($classId), new CarbonImmutable('2026-08-07'), '09:00', '11:00', 'p16-ses-3', $ids['reading_vocabulary']);
            $this->fail('a retired skill cannot be scheduled');
        } catch (BusinessRejection $rejection) {
            $this->assertSame('academic.session_skill_unknown', $rejection->errorCode());
        }

        try {
            DB::table('class_sessions')->insert([
                'id' => '00000000-0000-4000-8000-00000000beef',
                'class_id' => $classId,
                'skill_id' => $ids['reading_vocabulary'],
                'scheduled_on' => '2026-08-08',
                'starts_at' => '09:00',
                'ends_at' => '10:00',
            ]);
            $this->fail('the schema must reject direct inserts of retired-skill sessions');
        } catch (QueryException) {
            $this->addToAssertionCount(1);
        }
    }
}
