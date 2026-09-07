<?php

declare(strict_types=1);

namespace Tests\Feature\Academic;

use App\Modules\Academic\Commands\MaintainAcademicStructure;
use App\Modules\Academic\Commands\MaintainClass;
use App\Modules\Academic\Commands\ManageAcademicOffering;
use App\Modules\Academic\Models\AcademicPeriod;
use App\Modules\Academic\Models\ClassModel;
use App\Modules\Academic\Models\Offering;
use App\Modules\Academic\Models\Program;
use App\Modules\Organization\Models\Branch;
use App\Support\Errors\BusinessRejection;
use App\Support\Identifiers\RandomIdentifier;
use Carbon\CarbonImmutable;
use Tests\Concerns\BuildsActors;
use Tests\TestCase;

/**
 * Offering resize authority (WPA-CAP-BOUND): an offering's declared capacity is
 * the ceiling for every class born against it (class.capacity <=
 * offering.capacity — academic_class_authority_guard, 000160), and a class's
 * offering provenance is immutable. So resizing an offering below the largest
 * referencing class capacity would silently break that invariant. The command
 * must reject it up front (academic.offering_capacity_below_class), and the
 * 000190 trigger backstops the same rule at the SQL boundary for direct DML.
 */
final class OfferingCapacityClassBoundTest extends TestCase
{
    use BuildsActors;

    private string $branchId;

    private string $levelId;

    private string $periodId;

    private string $programVersionId;

    protected function setUp(): void
    {
        parent::setUp();
        $structure = app(MaintainAcademicStructure::class);
        $officer = $this->academicOfficer('cap-bound-setup');

        $this->branchId = Branch::query()->create([
            'id' => RandomIdentifier::new(),
            'name' => 'Cap Bound Branch '.substr(md5(RandomIdentifier::new()), 0, 8),
            'lifecycle_state' => 'active',
        ])->id;
        $this->attachBranchToBootstrapOrganization($this->branchId);

        $program = $structure->defineProgram($officer, 'Cap Bound Intensive', 'cap-prog');
        $version = $structure->publishVersion($officer, Program::query()->findOrFail($program['program_id']), 'Cap Bound v1', 'cap-ver');
        $this->programVersionId = $version['version_id'];
        $this->levelId = $structure->defineLevel($officer, $this->programVersionId, 'starter', 1, 'Starter', 'A1', 'cap-lvl')['level_id'];

        $this->periodId = $structure->definePeriod($officer, 'Cap Bound Term', new CarbonImmutable('2026-10-01'), new CarbonImmutable('2026-12-30'), 'cap-period')['period_id'];
        $structure->transitionPeriod($officer, AcademicPeriod::query()->findOrFail($this->periodId), 'published', 'cap-period-pub');

        $structure->declareBranchAvailability($officer, $this->branchId, $this->levelId, $this->periodId, 'cap-avail');
    }

    public function test_offering_cannot_resize_below_a_referencing_class_capacity(): void
    {
        $structure = app(MaintainAcademicStructure::class);
        $manager = app(ManageAcademicOffering::class);
        $officer = $this->academicOfficer('cap-bound-officer');

        $offeringId = $structure->openOffering($officer, $this->branchId, $this->levelId, $this->periodId, 10, 'cap-offering')['offering_id'];
        $classId = app(MaintainClass::class)->defineClass(
            $officer,
            $this->programVersionId,
            $this->periodId,
            8,
            'cap-class',
            $this->levelId,
            $this->branchId,
        )['class_id'];

        /** @var ClassModel $class */
        $class = ClassModel::query()->findOrFail($classId);
        $this->assertSame(8, (int) $class->capacity);
        $this->assertSame($offeringId, trim((string) $class->offering_id));

        // A shrink strictly below the referencing class capacity must be refused
        // even though no live seat claims remain.
        try {
            $manager->resizeCapacity($officer, Offering::query()->findOrFail($offeringId), 7, 'cap-shrink');
            $this->fail('an offering must not shrink below a referencing class capacity');
        } catch (BusinessRejection $rejection) {
            $this->assertSame('academic.offering_capacity_below_class', $rejection->errorCode());
        }

        // Resizing to exactly the referencing class capacity is permitted.
        $settled = $manager->resizeCapacity($officer, Offering::query()->findOrFail($offeringId), 8, 'cap-equal');
        $this->assertSame(8, $settled['capacity']);

        // Growing above it is always permitted as well.
        $grown = $manager->resizeCapacity($officer, Offering::query()->findOrFail($offeringId), 12, 'cap-grow');
        $this->assertSame(12, $grown['capacity']);
    }
}
