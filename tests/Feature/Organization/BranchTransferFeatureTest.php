<?php

declare(strict_types=1);

namespace Tests\Feature\Organization;

use App\Modules\Organization\Commands\TransferBranchToCampus;
use App\Modules\Organization\Models\CampusAssignment;
use App\Modules\Organization\Queries\EffectiveStructureQuery;
use App\Support\Errors\BusinessRejection;
use App\Support\Identifiers\RandomIdentifier;
use Carbon\CarbonImmutable;
use Illuminate\Database\UniqueConstraintViolationException;
use Tests\Concerns\BuildsActors;
use Tests\Concerns\OperatesStructure;
use Tests\TestCase;

final class BranchTransferFeatureTest extends TestCase
{
    use BuildsActors;
    use OperatesStructure;

    public function test_transfer_closes_the_prior_attribution_and_retains_history(): void
    {
        $organization = $this->establishActiveOrganization();
        $firstCampus = $this->establishActiveCampus($organization, 'First Campus');
        $secondCampus = $this->establishActiveCampus($organization, 'Second Campus');
        $branch = $this->establishActiveBranch($firstCampus, 'Transferred Branch');

        $outcome = app(TransferBranchToCampus::class)->transfer(
            $branch,
            $secondCampus,
            new CarbonImmutable('2026-09-01'),
            $this->structureDecisionForGlobalActors(),
            RandomIdentifier::new(),
        );

        $this->assertSame($firstCampus->id, $outcome['from_campus_id']);
        $this->assertSame($secondCampus->id, $outcome['to_campus_id']);
        $this->assertSame(2, CampusAssignment::query()->where('branch_id', $branch->id)->count());

        $closed = CampusAssignment::query()->where('branch_id', $branch->id)->whereNotNull('effective_to')->firstOrFail();
        $this->assertSame('2026-09-01', $closed->effective_to);
        $this->assertSame('2026-09-01', $closed->effective_from === '2026-01-01' ? $closed->effective_to : 'unreachable');

        $open = CampusAssignment::query()->where('branch_id', $branch->id)->whereNull('effective_to')->firstOrFail();
        $this->assertSame($secondCampus->id, $open->campus_id);
        $this->assertDatabaseHas('audit_events', [
            'operation' => 'organization.branch.transfer',
            'target_type' => 'branch',
            'target_id' => $branch->id,
        ]);
    }

    public function test_effective_structure_resolves_campus_attribution_as_of_the_requested_day(): void
    {
        $organization = $this->establishActiveOrganization();
        $firstCampus = $this->establishActiveCampus($organization, 'Historic Campus');
        $secondCampus = $this->establishActiveCampus($organization, 'Current Campus');
        $branch = $this->establishActiveBranch($firstCampus, 'Dated Branch');

        app(TransferBranchToCampus::class)->transfer(
            $branch,
            $secondCampus,
            new CarbonImmutable('2026-09-01'),
            $this->structureDecisionForGlobalActors(),
            RandomIdentifier::new(),
        );

        $query = new EffectiveStructureQuery;
        $before = $query->effectiveStructure(new CarbonImmutable('2026-05-01'));
        $after = $query->effectiveStructure(new CarbonImmutable('2026-10-01'));

        $this->assertSame($firstCampus->id, $this->branchCampusId($before['branches'], $branch->id));
        $this->assertSame($secondCampus->id, $this->branchCampusId($after['branches'], $branch->id));
    }

    public function test_transfer_to_the_current_campus_is_a_business_rejection(): void
    {
        $organization = $this->establishActiveOrganization();
        $campus = $this->establishActiveCampus($organization);
        $branch = $this->establishActiveBranch($campus);

        $this->expectException(BusinessRejection::class);
        $this->expectExceptionMessage('branch is already attributed to this campus');
        app(TransferBranchToCampus::class)->transfer($branch, $campus, new CarbonImmutable('2026-09-01'), $this->structureDecisionForGlobalActors(), RandomIdentifier::new());
    }

    public function test_transfer_date_overlapping_history_is_rejected(): void
    {
        $organization = $this->establishActiveOrganization();
        $firstCampus = $this->establishActiveCampus($organization, 'Campus One');
        $secondCampus = $this->establishActiveCampus($organization, 'Campus Two');
        $branch = $this->establishActiveBranch($firstCampus);

        $this->expectException(BusinessRejection::class);
        $this->expectExceptionMessage('transfer date must follow the current attribution start');
        app(TransferBranchToCampus::class)->transfer($branch, $secondCampus, new CarbonImmutable('2026-01-01'), $this->structureDecisionForGlobalActors(), RandomIdentifier::new());
    }

    public function test_two_open_attributions_are_structurally_impossible(): void
    {
        $organization = $this->establishActiveOrganization();
        $firstCampus = $this->establishActiveCampus($organization, 'First');
        $secondCampus = $this->establishActiveCampus($organization, 'Second');
        $branch = $this->establishActiveBranch($firstCampus);

        $this->expectException(UniqueConstraintViolationException::class);
        CampusAssignment::query()->create([
            'id' => RandomIdentifier::new(),
            'branch_id' => $branch->id,
            'campus_id' => $secondCampus->id,
            'effective_from' => '2026-09-01',
            'effective_to' => null,
            'transfer_correlation_id' => 'race-simulation',
        ]);
    }

    /**
     * @param  list<array<string, mixed>>  $branches
     */
    private function branchCampusId(array $branches, string $branchId): ?string
    {
        foreach ($branches as $branch) {
            if ($branch['id'] === $branchId) {
                /** @var string|null $campusId */
                $campusId = $branch['campus_id'];

                return $campusId;
            }
        }

        return null;
    }
}
