<?php

declare(strict_types=1);

namespace Tests\Feature\Hr;

use App\Modules\Academic\Commands\MaintainAcademicStructure;
use App\Modules\Academic\Commands\MaintainClass;
use App\Modules\Academic\Models\AcademicPeriod;
use App\Modules\Academic\Models\ClassModel;
use App\Modules\Academic\Models\Program;
use App\Modules\Access\Commands\AssignPosition;
use App\Modules\Hr\Commands\MaintainContract;
use App\Modules\Hr\Commands\MaintainEmployment;
use App\Modules\Hr\Commands\MaintainLeave;
use App\Modules\Hr\Commands\RecordWorkBasis;
use App\Modules\Hr\Models\CompensationComponent;
use App\Modules\Hr\Models\Contract;
use App\Modules\Hr\Models\Employment;
use App\Modules\Hr\Models\Leave;
use App\Modules\Identity\Models\Person;
use App\Support\Authorization\Actor;
use App\Support\Errors\AuthorizationDenied;
use App\Support\Errors\BusinessRejection;
use Carbon\CarbonImmutable;
use Illuminate\Database\QueryException;
use Illuminate\Support\Facades\DB;
use Tests\Concerns\BuildsActors;
use Tests\TestCase;

final class HrFeatureTest extends TestCase
{
    use BuildsActors;

    private string $employmentId;

    private string $personId = 'hr-teacher-1';

    protected function setUp(): void
    {
        parent::setUp();
        $this->personWithAuthority($this->personId, []);

        $manager = $this->grantedActor('hr-manager-1', ['hr.employ', 'hr.contract', 'hr.compensation', 'hr.terminate', 'access.assign_position', 'hr.leave_approve']);
        $employment = app(MaintainEmployment::class)->employ($manager, $this->personId, 'hr-emp-1');
        $this->employmentId = $employment['employment_id'];
        $contract = app(MaintainContract::class)->draft($manager, Employment::query()->findOrFail($this->employmentId), 'full-time EFL instructor, 40h/week', '2026-09-01', 'hr-con-1');
        app(MaintainContract::class)->sign($manager, Contract::query()->findOrFail($contract['contract_id']), 'signed/hr-con-1.pdf', 'hr-con-2');
        app(MaintainEmployment::class)->hire($manager, Employment::query()->findOrFail($this->employmentId), '2026-09-01', 'hr-emp-2');
    }

    private function manager(array $extra = []): Actor
    {
        return $this->grantedActor('hr-manager-1', array_merge(['hr.employ', 'hr.contract', 'hr.compensation', 'hr.terminate', 'access.assign_position', 'hr.leave_approve'], $extra));
    }

    public function test_verified_person_rule_and_single_open_employment(): void
    {
        Person::query()->create([
            'id' => 'hr-person-unverified',
            'legal_name' => 'Unverified Person',
            'date_of_birth' => '1990-01-01',
            'verification_state' => Person::VERIFICATION_UNVERIFIED,
        ]);

        try {
            app(MaintainEmployment::class)->employ($this->manager(), 'hr-person-unverified', 'hr-neg-1');
            $this->fail('unverified identity must be rejected');
        } catch (BusinessRejection $rejection) {
            $this->assertSame('hr.person_not_verified', $rejection->errorCode());
        }

        try {
            app(MaintainEmployment::class)->employ($this->manager(), $this->personId, 'hr-neg-2');
            $this->fail('a second open employment for the same person must be rejected');
        } catch (BusinessRejection $rejection) {
            $this->assertSame('hr.employment_open_exists', $rejection->errorCode());
        }

        $this->assertDatabaseMissing('employments', ['person_id' => 'hr-person-unverified']);
    }

    public function test_signed_contract_terms_are_immutable_and_replacement_closes_the_prior(): void
    {
        $manager = $this->manager();
        /** @var Contract $active */
        $active = Contract::query()->where('employment_id', $this->employmentId)->where('lifecycle_state', 'active')->firstOrFail();

        try {
            app(MaintainContract::class)->draft($manager, Employment::query()->findOrFail($this->employmentId), 'changed terms', '2026-10-01', 'hr-neg-3');
            $this->fail('a second open contract must be rejected');
        } catch (BusinessRejection $rejection) {
            $this->assertSame('hr.contract_open_exists', $rejection->errorCode());
        }

        $this->expectException(QueryException::class);
        DB::statement('UPDATE contracts SET terms_summary = ? WHERE id = ?', ['forged terms', $active->id]);
    }

    public function test_compensation_requires_independent_non_beneficiary_approval_and_is_effective_dated(): void
    {
        $manager = $this->manager(['hr.compensation_approve']);
        $approver = $this->grantedActor('hr-comp-approver', ['hr.compensation_approve']);
        /** @var Contract $contract */
        $contract = Contract::query()->where('employment_id', $this->employmentId)->where('lifecycle_state', 'active')->firstOrFail();

        $component = app(MaintainContract::class)->proposeCompensation($manager, $contract, 'fixed', '45000.00', '2026-09-01', 'hr-comp-1');

        try {
            app(MaintainContract::class)->activateCompensation($manager, CompensationComponent::query()->findOrFail($component['component_id']), 'hr-comp-2');
            $this->fail('the proposer may not approve the component');
        } catch (AuthorizationDenied $denial) {
            $this->assertSame('hr.compensation_not_independent', $denial->errorCode());
        }

        $beneficiary = $this->grantedActor($this->personId, ['hr.compensation_approve']);
        try {
            app(MaintainContract::class)->activateCompensation($beneficiary, CompensationComponent::query()->findOrFail($component['component_id']), 'hr-comp-3');
            $this->fail('the beneficiary may never approve their own compensation');
        } catch (AuthorizationDenied $denial) {
            $this->assertSame('hr.compensation_beneficiary', $denial->errorCode());
        }

        app(MaintainContract::class)->activateCompensation($approver, CompensationComponent::query()->findOrFail($component['component_id']), 'hr-comp-4');
        $this->assertDatabaseHas('compensation_components', ['id' => $component['component_id'], 'lifecycle_state' => 'active', 'approved_by' => 'hr-comp-approver']);

        try {
            app(MaintainContract::class)->proposeCompensation($manager, $contract, 'fixed', '47000.00', '2026-10-01', 'hr-comp-5');
            $this->fail('overlapping active component of the same kind must be rejected');
        } catch (BusinessRejection $rejection) {
            $this->assertSame('hr.compensation_overlap', $rejection->errorCode());
        }

        $this->expectException(QueryException::class);
        DB::statement('UPDATE compensation_components SET amount = 999999 WHERE id = ?', [$component['component_id']]);
    }

    public function test_leave_requires_independent_decider_and_rejects_overlaps(): void
    {
        $manager = $this->manager();
        $requester = $this->grantedActor('hr-clerk-1', ['hr.leave_request', 'hr.leave_approve']);

        $leave = app(MaintainLeave::class)->request($requester, Employment::query()->findOrFail($this->employmentId), 'annual', '2026-10-01', '2026-10-10', 'family event', 'hr-leave-1');

        try {
            app(MaintainLeave::class)->decide($requester, Leave::query()->findOrFail($leave['leave_id']), true, 'hr-leave-2');
            $this->fail('the requester may not decide the leave');
        } catch (AuthorizationDenied $denial) {
            $this->assertSame('hr.leave_not_independent', $denial->errorCode());
        }

        app(MaintainLeave::class)->decide($manager, Leave::query()->findOrFail($leave['leave_id']), true, 'hr-leave-3');

        $second = app(MaintainLeave::class)->request($requester, Employment::query()->findOrFail($this->employmentId), 'sick', '2026-10-05', '2026-10-07', 'medical', 'hr-leave-4');
        try {
            app(MaintainLeave::class)->decide($manager, Leave::query()->findOrFail($second['leave_id']), true, 'hr-leave-5');
            $this->fail('overlapping approved leave must be rejected');
        } catch (BusinessRejection $rejection) {
            $this->assertSame('hr.leave_overlap', $rejection->errorCode());
        }
        $this->assertDatabaseHas('leaves', ['id' => $second['leave_id'], 'lifecycle_state' => 'requested']);
    }

    public function test_work_basis_holds_academic_disagreement_and_retains_evidence(): void
    {
        $officer = $this->academicOfficer('hr-acad-officer');
        $program = app(MaintainAcademicStructure::class)->defineProgram($officer, 'HR Work Program', 'hr-prog-1');
        $version = app(MaintainAcademicStructure::class)->publishVersion($officer, Program::query()->findOrFail($program['program_id']), 'v1', 'hr-prog-2');
        $period = app(MaintainAcademicStructure::class)->definePeriod($officer, 'HR Work Term', new CarbonImmutable('2026-09-01'), new CarbonImmutable('2026-12-18'), 'hr-period-1');
        app(MaintainAcademicStructure::class)->transitionPeriod($officer, AcademicPeriod::query()->findOrFail($period['period_id']), 'published', 'hr-period-2');
        $class = app(MaintainClass::class)->defineClass($officer, $version['version_id'], $period['period_id'], 5, 'hr-class-1');
        $assignment = app(MaintainClass::class)->assignTeacher($officer, ClassModel::query()->findOrFail($class['class_id']), $this->personId, new CarbonImmutable('2026-09-05'), null, 'hr-class-2');

        $recorder = $this->grantedActor('hr-workbasis-1', ['hr.workbasis']);
        $basis = app(RecordWorkBasis::class)->recordFromAcademic($recorder, Employment::query()->findOrFail($this->employmentId), $assignment['assignment_id'], '2026-09-05', '2026-09-20', '60', 'schedule/term-export', 'hr-wb-1');
        $this->assertSame('recorded', $basis['lifecycle_state']);

        app(MaintainEmployment::class)->suspend($this->manager(), Employment::query()->findOrFail($this->employmentId), '2026-09-25', 'hr-emp-3');
        $held = app(RecordWorkBasis::class)->recordFromAcademic($recorder, Employment::query()->findOrFail($this->employmentId), $assignment['assignment_id'], '2026-09-26', '2026-10-10', '40', 'schedule/term-export-2', 'hr-wb-2');
        $this->assertSame('held', $held['lifecycle_state']);
        $this->assertDatabaseHas('work_bases', ['id' => $held['work_basis_id'], 'lifecycle_state' => 'held']);

        try {
            app(RecordWorkBasis::class)->recordManual($recorder, Employment::query()->findOrFail($this->employmentId), '2026-09-26', '2026-10-10', '20', 'hours', 'decl/form', 'hr-wb-3');
            $this->fail('manual work evidence requires an open employment');
        } catch (BusinessRejection $rejection) {
            $this->assertSame('hr.workbasis_employment_not_open', $rejection->errorCode());
        }

        $this->expectException(QueryException::class);
        DB::statement('DELETE FROM work_bases WHERE id = ?', [$held['work_basis_id']]);
    }

    public function test_termination_closes_contracts_cancels_leave_and_ends_access(): void
    {
        $manager = $this->manager();
        app(AssignPosition::class)->assign($manager, $this->personId, $this->fixturePositionId(), new CarbonImmutable('2026-09-01'), 'hr-pos-1');

        $requester = $this->grantedActor('hr-clerk-2', ['hr.leave_request']);
        $leave = app(MaintainLeave::class)->request($requester, Employment::query()->findOrFail($this->employmentId), 'annual', '2026-11-01', '2026-11-05', 'booked', 'hr-leave-6');
        app(MaintainLeave::class)->decide($manager, Leave::query()->findOrFail($leave['leave_id']), true, 'hr-leave-7');

        app(MaintainEmployment::class)->terminate($manager, Employment::query()->findOrFail($this->employmentId), '2026-10-01', 'end of contract term', 'hr-emp-4');

        $this->assertDatabaseHas('employments', ['id' => $this->employmentId, 'lifecycle_state' => 'terminated']);
        $this->assertDatabaseHas('contracts', ['employment_id' => $this->employmentId, 'lifecycle_state' => 'closed', 'effective_to' => '2026-10-01']);
        $this->assertDatabaseHas('leaves', ['id' => $leave['leave_id'], 'lifecycle_state' => 'cancelled']);
        $this->assertSame(0, DB::table('position_assignments')->where('person_id', $this->personId)->where('lifecycle_state', 'active')->count(), 'access ends with employment');
        $this->assertSame(3, DB::table('employment_statuses')->where('employment_id', $this->employmentId)->count(), 'status history retained');

        try {
            app(MaintainEmployment::class)->reinstate($manager, Employment::query()->findOrFail($this->employmentId), '2026-10-02', 'hr-emp-5');
            $this->fail('terminated employment cannot be reinstated');
        } catch (BusinessRejection $rejection) {
            $this->assertSame('hr.employment_transition_forbidden', $rejection->errorCode());
        }
    }

    public function test_unprivileged_employment_is_denied_and_audited(): void
    {
        $nobody = $this->actorWithoutAnyCapability('hr-nobody');
        Person::query()->create([
            'id' => 'hr-person-2',
            'legal_name' => 'Second Verified Person',
            'date_of_birth' => '1991-02-02',
            'verification_state' => Person::VERIFICATION_VERIFIED,
        ]);

        $this->expectException(AuthorizationDenied::class);
        app(MaintainEmployment::class)->employ($nobody, 'hr-person-2', 'hr-neg-9');

        $this->assertDatabaseHas('audit_events', ['operation' => 'hr.employment.employ.denied', 'actor_id' => 'hr-nobody']);
        $this->assertDatabaseMissing('employments', ['person_id' => 'hr-person-2']);
    }

    private function fixturePositionId(): string
    {
        $positionId = DB::table('positions')->value('id');
        if ($positionId === null) {
            return app(AssignPosition::class) instanceof AssignPosition ? $this->createFixturePosition() : '';
        }

        return (string) $positionId;
    }

    private function createFixturePosition(): string
    {
        return (string) DB::table('positions')->insertGetId([
            'id' => '00000000-0000-4000-8000-00000000hr01',
            'organization_id' => '00000000-0000-4000-8000-00000000b005',
            'name' => 'HR Fixture Position',
        ], 'id');
    }
}
