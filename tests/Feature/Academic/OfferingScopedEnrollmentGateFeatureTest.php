<?php

declare(strict_types=1);

namespace Tests\Feature\Academic;

use App\Modules\Academic\Commands\MaintainAcademicStructure;
use App\Modules\Academic\Commands\MaintainClass;
use App\Modules\Academic\Commands\MaintainEnrollment;
use App\Modules\Academic\Errors\EnrollmentFinancialGateDenied;
use App\Modules\Academic\Models\AcademicPeriod;
use App\Modules\Academic\Models\ClassModel;
use App\Modules\Academic\Models\Enrollment;
use App\Modules\Academic\Models\Program;
use App\Modules\Admissions\Commands\EnrollAdmittedApplicant;
use App\Modules\Admissions\Commands\RegisterApplicant;
use App\Modules\Admissions\Models\Applicant;
use App\Modules\Finance\Commands\PostObligation;
use App\Modules\Finance\Models\FinancialPeriod;
use App\Modules\Organization\Models\Branch;
use App\Support\Authorization\Actor;
use App\Support\Errors\BusinessRejection;
use App\Support\Identifiers\RandomIdentifier;
use Carbon\CarbonImmutable;
use Illuminate\Database\QueryException;
use Illuminate\Support\Facades\DB;
use Tests\Concerns\BuildsActors;
use Tests\Concerns\DecidesAdmissions;
use Tests\TestCase;

/**
 * AC5: enrollment-to-offering end-to-end. A level-targeted class must be
 * enrolled through the open Offering packaging that class level/term; the
 * Finance gate is scoped to that offering context so an unrelated charge on
 * a different Offering cannot block activation. Legacy non-level classes
 * keep the NULL-offering path.
 */
final class OfferingScopedEnrollmentGateFeatureTest extends TestCase
{
    use BuildsActors;
    use DecidesAdmissions;

    private string $programVersionId;

    private string $periodId;

    private string $branchId;

    private string $levelA1;

    private string $levelA2;

    private string $levelB1;

    private string $offeringA1;

    private string $offeringA2;

    private string $offeringB1;

    private string $classA1;

    private string $classA2;

    private string $classB1;

    private string $legacyClass;

    protected function setUp(): void
    {
        parent::setUp();
        $this->personWithAuthority('off-teacher-1', []);
        $structure = app(MaintainAcademicStructure::class);
        $officer = $this->academicOfficer('off-officer');

        $program = $structure->defineProgram($officer, 'Offering Scoped Program', 'off-scoped-prog');
        $this->programVersionId = $structure->publishVersion($officer, Program::query()->findOrFail($program['program_id']), 'off-scoped-v1', 'off-scoped-ver')['version_id'];

        $this->levelA1 = $structure->defineLevel($officer, $this->programVersionId, 'A1', 1, 'A1 level', 'A1', 'off-lvl-a1')['level_id'];
        $this->levelA2 = $structure->defineLevel($officer, $this->programVersionId, 'A2', 2, 'A2 level', 'A2', 'off-lvl-a2')['level_id'];
        $this->levelB1 = $structure->defineLevel($officer, $this->programVersionId, 'B1', 3, 'B1 level', 'B1', 'off-lvl-b1')['level_id'];

        $this->periodId = $structure->definePeriod($officer, 'Off Scoped Term', new CarbonImmutable('2026-09-01'), new CarbonImmutable('2026-12-18'), 'off-scoped-period')['period_id'];
        $structure->transitionPeriod($officer, AcademicPeriod::query()->findOrFail($this->periodId), 'published', 'off-scoped-period-pub');

        $this->branchId = Branch::query()->create([
            'id' => RandomIdentifier::new(),
            'name' => 'Off Scoped Branch '.substr(md5(RandomIdentifier::new()), 0, 8),
            'lifecycle_state' => 'active',
        ])->id;

        $this->offeringA1 = $this->offering($structure, $officer, $this->levelA1, 'off-a1');
        $this->offeringA2 = $this->offering($structure, $officer, $this->levelA2, 'off-a2');
        $this->offeringB1 = $this->offering($structure, $officer, $this->levelB1, 'off-b1');

        $this->classA1 = $this->levelClass($structure, $officer, 'off-class-a1', $this->levelA1);
        $this->classA2 = $this->levelClass($structure, $officer, 'off-class-a2', $this->levelA2);
        $this->classB1 = $this->levelClass($structure, $officer, 'off-class-b1', $this->levelB1);
        $this->legacyClass = $this->legacyClass($structure, $officer, 'off-class-legacy');
    }

    public function test_level_targeted_enrollment_requires_offering(): void
    {
        $studentId = $this->newStudent('off-student-required');

        try {
            app(MaintainEnrollment::class)->request($this->enrollmentClerk('off-enroll-required'), $studentId, $this->classA2, 'off-req-required');
            $this->fail('a level-targeted class must be enrolled through an offering');
        } catch (BusinessRejection $rejection) {
            $this->assertSame('academic.enrollment_offering_required', $rejection->errorCode());
        }

        $this->assertDatabaseMissing('enrollments', ['student_id' => $studentId, 'class_id' => $this->classA2]);
    }

    public function test_legacy_non_level_class_allows_null_offering(): void
    {
        $studentId = $this->newStudent('off-student-legacy');
        $seat = app(MaintainEnrollment::class)->request($this->enrollmentClerk('off-req-legacy'), $studentId, $this->legacyClass, 'off-req-legacy-key');

        $this->assertDatabaseHas('enrollments', ['id' => $seat['enrollment_id'], 'offering_id' => null, 'lifecycle_state' => 'requested']);
    }

    public function test_offering_scoped_gate_ignores_unrelated_offering_obligation(): void
    {
        $studentId = $this->newStudent('off-student-scoped');
        $a1Seat = app(MaintainEnrollment::class)->request($this->enrollmentClerk('off-req-a1'), $studentId, $this->classA1, 'off-req-a1', $this->offeringA1);
        $this->assertNotNull($a1Seat['enrollment_id']);

        $poster = $this->grantedActor('off-finance-a1', ['finance.obligation']);
        $period = $this->openPeriod('off-a1-ob');
        app(PostObligation::class)->post($poster, $period, $studentId, 'tuition', 'A1 tuition', [
            ['category' => 'tuition', 'amount' => '1000.00', 'source_ref' => 'off-a1-price'],
        ], 'off-ob-a1', $this->offeringA1);

        // The unpaid A1 obligation must not block activation of the A2 offering.
        $a2Seat = app(MaintainEnrollment::class)->request($this->enrollmentClerk('off-req-a2'), $studentId, $this->classA2, 'off-req-a2', $this->offeringA2);
        $activation = app(MaintainEnrollment::class)->activate($this->academicOfficer('off-activate-a2'), Enrollment::query()->findOrFail($a2Seat['enrollment_id']), 'off-activate-a2');
        $this->assertSame('active', $activation['lifecycle_state']);
        $this->assertSame('0.00', Enrollment::query()->findOrFail($a2Seat['enrollment_id'])->financial_gate_evidence['remaining']);
    }

    public function test_offering_scoped_gate_applies_its_own_offering_obligation(): void
    {
        $studentId = $this->newStudent('off-student-own');
        $a2Seat = app(MaintainEnrollment::class)->request($this->enrollmentClerk('off-req-own'), $studentId, $this->classA2, 'off-req-own', $this->offeringA2);

        $poster = $this->grantedActor('off-finance-a2', ['finance.obligation']);
        $period = $this->openPeriod('off-a2-ob');
        app(PostObligation::class)->post($poster, $period, $studentId, 'tuition', 'A2 tuition', [
            ['category' => 'tuition', 'amount' => '1000.00', 'source_ref' => 'off-a2-price'],
        ], 'off-ob-a2', $this->offeringA2);

        try {
            app(MaintainEnrollment::class)->activate($this->academicOfficer('off-activate-own'), Enrollment::query()->findOrFail($a2Seat['enrollment_id']), 'off-activate-own');
            $this->fail('an obligation on the same offering must block activation');
        } catch (EnrollmentFinancialGateDenied $denial) {
            $this->assertSame('academic.enrollment.financial_gate', $denial->errorCode());
        }
        $this->assertSame('requested', Enrollment::query()->findOrFail($a2Seat['enrollment_id'])->lifecycle_state);
    }

    public function test_direct_sql_cannot_enroll_level_class_without_offering(): void
    {
        $studentId = $this->newStudent('off-student-direct');

        $this->expectException(QueryException::class);
        DB::table('enrollments')->insert([
            'id' => RandomIdentifier::new(),
            'student_id' => $studentId,
            'class_id' => $this->classA2,
            'lifecycle_state' => 'requested',
            'created_at' => now(), 'updated_at' => now(),
        ]);
    }

    public function test_direct_sql_cannot_attach_mismatched_offering_to_level_class(): void
    {
        $studentId = $this->newStudent('off-student-mismatch');

        $this->expectException(QueryException::class);
        DB::table('enrollments')->insert([
            'id' => RandomIdentifier::new(),
            'student_id' => $studentId,
            'class_id' => $this->classA2,
            'offering_id' => $this->offeringA1,
            'lifecycle_state' => 'requested',
            'created_at' => now(), 'updated_at' => now(),
        ]);
    }

    private function offering(MaintainAcademicStructure $structure, Actor $officer, string $levelId, string $key): string
    {
        $structure->declareBranchAvailability($officer, $this->branchId, $levelId, $this->periodId, $key.'-avail');

        return $structure->openOffering($officer, $this->branchId, $levelId, $this->periodId, 10, $key)['offering_id'];
    }

    private function levelClass(MaintainAcademicStructure $structure, Actor $officer, string $key, string $levelId): string
    {
        $classId = app(MaintainClass::class)->defineClass($officer, $this->programVersionId, $this->periodId, 10, $key, $levelId)['class_id'];
        $this->activateClass($officer, $classId, $key);

        return $classId;
    }

    private function legacyClass(MaintainAcademicStructure $structure, Actor $officer, string $key): string
    {
        $classId = app(MaintainClass::class)->defineClass($officer, $this->programVersionId, $this->periodId, 10, $key)['class_id'];
        $this->activateClass($officer, $classId, $key);

        return $classId;
    }

    private function activateClass(Actor $officer, string $classId, string $key): void
    {
        app(MaintainClass::class)->assignTeacher($officer, ClassModel::query()->findOrFail($classId), 'off-teacher-1', new CarbonImmutable('2026-09-01'), null, $key.'-teacher');
        app(MaintainClass::class)->transition($officer, ClassModel::query()->findOrFail($classId), 'published', $key.'-pub');
        app(MaintainClass::class)->transition($officer, ClassModel::query()->findOrFail($classId), 'active', $key.'-active');
    }

    private function newStudent(string $personId): string
    {
        $this->personWithAuthority($personId, []);
        $registered = app(RegisterApplicant::class)->register($this->admissionsClerk($personId.'-clerk'), $personId, 'Program', $personId.'-reg');
        /** @var Applicant $applicant */
        $applicant = Applicant::query()->findOrFail($registered['applicant_id']);
        $this->runAdmissionDecision(
            $this->admissionsClerk($personId.'-clerk'),
            $this->admissionsReviewer($personId.'-review'),
            $this->admissionsApprover($personId.'-approve'),
            $applicant,
            true,
            'meets policy',
            'ev/off',
            $personId.'-adm',
        );

        return app(EnrollAdmittedApplicant::class)->convert($this->admissionsApprover($personId.'-approve'), $applicant, $personId.'-conv')['student_id'];
    }

    private function openPeriod(string $seed): FinancialPeriod
    {
        return FinancialPeriod::query()->create([
            'id' => RandomIdentifier::new(),
            'period_key' => $seed.'-'.substr(md5(RandomIdentifier::new()), 0, 8),
            'date_from' => '2026-09-01',
            'date_to' => '2026-12-31',
            'lifecycle_state' => 'open',
        ]);
    }
}
