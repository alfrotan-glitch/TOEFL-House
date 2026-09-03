<?php

declare(strict_types=1);

namespace Tests\Feature\Academic;

use App\Modules\Academic\Commands\MaintainAcademicStructure;
use App\Modules\Academic\Models\Program;
use App\Modules\Academic\Models\ProgramVersionLevel;
use App\Support\Errors\BusinessRejection;
use App\Support\Identifiers\RandomIdentifier;
use Carbon\CarbonImmutable;
use Illuminate\Database\QueryException;
use Illuminate\Support\Facades\DB;
use Tests\Concerns\BuildsActors;
use Tests\TestCase;

/**
 * WP-2 F2 (WP2-DEC-02): ProgramVersionLevel is the authoritative level/version
 * model — ordered levels unique per immutable program version, with optional
 * CEFR. A class's level must belong to the class's own program version
 * (schema-enforced), and pre-existing classes keep an unassigned (NULL) level.
 */
final class ProgramVersionLevelFoundationTest extends TestCase
{
    use BuildsActors;

    private string $versionId;

    protected function setUp(): void
    {
        parent::setUp();
        $structure = app(MaintainAcademicStructure::class);
        $officer = $this->academicOfficer();
        $program = $structure->defineProgram($officer, 'Intensive English F2', 'f2-prog');
        $this->versionId = $structure->publishVersion(
            $officer,
            Program::query()->findOrFail($program['program_id']),
            'F2 base version',
            'f2-ver-1',
        )['version_id'];
    }

    public function test_levels_are_ordered_and_unique_per_program_version(): void
    {
        $structure = app(MaintainAcademicStructure::class);
        $officer = $this->academicOfficer();

        $first = $structure->defineLevel($officer, $this->versionId, 'beginner', 1, 'Beginner', 'A1', 'f2-lvl-1');
        $this->assertNotNull(DB::table('program_version_levels')->where('id', $first['level_id'])->first());

        $structure->defineLevel($officer, $this->versionId, 'intermediate', 2, 'Intermediate', 'B1', 'f2-lvl-2');

        $this->assertSame(2, ProgramVersionLevel::query()->where('program_version_id', $this->versionId)->count());
    }

    public function test_duplicate_level_key_or_ordinal_is_rejected(): void
    {
        $structure = app(MaintainAcademicStructure::class);
        $officer = $this->academicOfficer();
        $structure->defineLevel($officer, $this->versionId, 'beginner', 1, 'Beginner', 'A1', 'f2-lvl-a');

        try {
            $structure->defineLevel($officer, $this->versionId, 'beginner', 2, 'Dupe key', null, 'f2-lvl-b');
            $this->fail('A duplicate level_key must be rejected.');
        } catch (BusinessRejection $e) {
            $this->assertSame('academic.level_key_exists', $e->errorCode());
        }

        try {
            $structure->defineLevel($officer, $this->versionId, 'other', 1, 'Dupe ordinal', null, 'f2-lvl-c');
            $this->fail('A duplicate ordinal must be rejected.');
        } catch (BusinessRejection $e) {
            $this->assertSame('academic.level_ordinal_exists', $e->errorCode());
        }

        try {
            $structure->defineLevel($officer, $this->versionId, 'zero', 0, 'Zero ordinal', null, 'f2-lvl-d');
            $this->fail('A non-positive ordinal must be rejected.');
        } catch (BusinessRejection $e) {
            $this->assertSame('academic.level_ordinal_positive', $e->errorCode());
        }
    }

    public function test_a_class_level_must_belong_to_the_class_program_version(): void
    {
        $structure = app(MaintainAcademicStructure::class);
        $officer = $this->academicOfficer();
        $level = $structure->defineLevel($officer, $this->versionId, 'beginner', 1, 'Beginner', 'A1', 'f2-lvl-e');
        $periodId = $structure->definePeriod($officer, 'F2 Term', new CarbonImmutable('2026-09-01'), new CarbonImmutable('2026-12-18'), 'f2-period')['period_id'];

        // A second version whose levels do not include the first version's level.
        $version2 = $structure->publishVersion(
            $officer,
            Program::query()->where('name', 'Intensive English F2')->firstOrFail(),
            'F2 second version',
            'f2-ver-2',
        )['version_id'];

        $this->insertClass($this->versionId, $periodId);

        // Assigning the first version's level to a class of version 1 is valid.
        DB::table('classes')
            ->where('program_version_id', $this->versionId)
            ->update(['program_version_level_id' => $level['level_id']]);
        $this->assertSame($level['level_id'], DB::table('classes')->where('program_version_id', $this->versionId)->value('program_version_level_id'));

        // Assigning a version-1 level to a class of version 2 is rejected.
        $this->insertClass($version2, $periodId);
        try {
            DB::table('classes')->where('program_version_id', $version2)
                ->update(['program_version_level_id' => $level['level_id']]);
            $this->fail('A class level from a different program version must be rejected.');
        } catch (QueryException $e) {
            $this->assertStringContainsString('does not belong to the class program version', $e->getMessage());
        }
    }

    private function insertClass(string $programVersionId, string $periodId): void
    {
        DB::table('classes')->insert([
            'id' => RandomIdentifier::new(),
            'program_version_id' => $programVersionId,
            'period_id' => $periodId,
            'capacity' => 20,
            'lifecycle_state' => 'planned',
            'created_at' => now()->toDateTimeString(),
            'updated_at' => now()->toDateTimeString(),
        ]);
    }
}
