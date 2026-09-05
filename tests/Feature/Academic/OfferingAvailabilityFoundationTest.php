<?php

declare(strict_types=1);

namespace Tests\Feature\Academic;

use App\Modules\Academic\Commands\MaintainAcademicStructure;
use App\Modules\Academic\Models\AcademicPeriod;
use App\Modules\Academic\Models\Program;
use App\Modules\Organization\Models\Branch;
use App\Support\Errors\BusinessRejection;
use App\Support\Identifiers\RandomIdentifier;
use Carbon\CarbonImmutable;
use Illuminate\Database\QueryException;
use Illuminate\Support\Facades\DB;
use Tests\Concerns\BuildsActors;
use Tests\TestCase;

/**
 * WP-2 F3 (WP2-DEC-03): co-dependent BranchAvailability + Term + Offering.
 * An Offering exists only for an ACTIVE (branch x level x term) availability in
 * an open term — enforced by the domain command and backstopped by the schema.
 */
final class OfferingAvailabilityFoundationTest extends TestCase
{
    use BuildsActors;

    private string $levelId;

    private string $periodId;

    private string $branchId;

    protected function setUp(): void
    {
        parent::setUp();
        $structure = app(MaintainAcademicStructure::class);
        $officer = $this->academicOfficer();

        $this->branchId = Branch::query()->create([
            'id' => RandomIdentifier::new(),
            'name' => 'F3 Branch '.substr(md5(RandomIdentifier::new()), 0, 8),
            'lifecycle_state' => 'active',
        ])->id;
        $this->attachBranchToBootstrapOrganization($this->branchId);

        $program = $structure->defineProgram($officer, 'F3 Intensive', 'f3-prog');
        $versionId = $structure->publishVersion($officer, Program::query()->findOrFail($program['program_id']), 'F3 v1', 'f3-ver')['version_id'];
        $this->levelId = $structure->defineLevel($officer, $versionId, 'starter', 1, 'Starter', 'A1', 'f3-lvl')['level_id'];

        $this->periodId = $structure->definePeriod($officer, 'F3 Term', new CarbonImmutable('2026-10-01'), new CarbonImmutable('2026-12-30'), 'f3-period')['period_id'];
        $structure->transitionPeriod($officer, AcademicPeriod::query()->findOrFail($this->periodId), 'published', 'f3-pub');
    }

    public function test_offering_requires_an_active_availability(): void
    {
        $structure = app(MaintainAcademicStructure::class);
        $officer = $this->academicOfficer();

        try {
            $structure->openOffering($officer, $this->branchId, $this->levelId, $this->periodId, 20, 'f3-off-1');
            $this->fail('An offering without a matching availability must be rejected.');
        } catch (BusinessRejection $e) {
            $this->assertSame('academic.offering_without_availability', $e->errorCode());
        }

        // The schema backstops the rule even against a direct insert.
        try {
            DB::table('offerings')->insert([
                'id' => RandomIdentifier::new(),
                'branch_id' => $this->branchId,
                'program_version_level_id' => $this->levelId,
                'academic_period_id' => $this->periodId,
                'capacity' => 20,
                'lifecycle_state' => 'open',
                'created_at' => now()->toDateTimeString(),
                'updated_at' => now()->toDateTimeString(),
            ]);
            $this->fail('The schema must reject an offering with no active availability.');
        } catch (QueryException $e) {
            $this->assertStringContainsString('requires an active branch availability', $e->getMessage());
        }
    }

    public function test_declared_availability_enables_an_offering_and_duplicates_are_rejected(): void
    {
        $structure = app(MaintainAcademicStructure::class);
        $officer = $this->academicOfficer();

        $availability = $structure->declareBranchAvailability($officer, $this->branchId, $this->levelId, $this->periodId, 'f3-avail');
        $this->assertSame('active', DB::table('branch_availabilities')->where('id', $availability['availability_id'])->value('lifecycle_state'));

        $offering = $structure->openOffering($officer, $this->branchId, $this->levelId, $this->periodId, 20, 'f3-off-2');
        $this->assertSame(1, DB::table('offerings')->where('id', $offering['offering_id'])->count());

        try {
            $structure->openOffering($officer, $this->branchId, $this->levelId, $this->periodId, 15, 'f3-off-3');
            $this->fail('A duplicate offering triple must be rejected.');
        } catch (BusinessRejection $e) {
            $this->assertSame('academic.offering_exists', $e->errorCode());
        }

        try {
            $structure->declareBranchAvailability($officer, $this->branchId, $this->levelId, $this->periodId, 'f3-avail-2');
            $this->fail('A duplicate availability triple must be rejected.');
        } catch (BusinessRejection $e) {
            $this->assertSame('academic.availability_exists', $e->errorCode());
        }
    }
}
