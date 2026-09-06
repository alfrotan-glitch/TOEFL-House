<?php

declare(strict_types=1);

namespace Tests\Feature\Organization;

use App\Modules\Audit\Models\AuditEvent;
use App\Modules\Organization\Commands\RenameStructureUnit;
use App\Modules\Organization\Models\CampusAssignment;
use App\Support\Errors\BusinessRejection;
use App\Support\Identifiers\RandomIdentifier;
use Carbon\CarbonImmutable;
use Illuminate\Database\QueryException;
use Tests\Concerns\BuildsActors;
use Tests\Concerns\OperatesStructure;
use Tests\TestCase;

final class StructureCommandFeatureTest extends TestCase
{
    use BuildsActors;
    use OperatesStructure;

    public function test_organization_creation_persists_draft_fact_with_audit_evidence(): void
    {
        $outcome = $this->createCommand()->createOrganization($this->structureDecisionForGlobalActors(), 'The TOEFL House', RandomIdentifier::new());

        $this->assertSame('organization', $outcome['unit_type']);
        $this->assertDatabaseHas('organizations', ['id' => $outcome['id'], 'name' => 'The TOEFL House', 'lifecycle_state' => 'draft']);
        $this->assertDatabaseHas('audit_events', [
            'operation' => 'organization.structure.create',
            'target_type' => 'organization',
            'target_id' => $outcome['id'],
            'after_state' => json_encode(['name' => 'The TOEFL House', 'lifecycle_state' => 'draft']),
        ]);
    }

    public function test_campus_creation_requires_the_parent_organization_to_be_active(): void
    {
        $decision = $this->structureDecisionForGlobalActors();
        $organization = $this->createCommand()->createOrganization($decision, 'Dormant Organization', RandomIdentifier::new());

        $this->expectException(BusinessRejection::class);
        $this->expectExceptionCode(0);
        $this->createCommand()->createCampus($decision, $organization['id'], 'Early Campus', RandomIdentifier::new());
    }

    public function test_branch_creation_assigns_the_initial_campus_attribution_atomically(): void
    {
        $organization = $this->establishActiveOrganization();
        $campus = $this->establishActiveCampus($organization);

        $outcome = $this->createCommand()->createBranch(
            $this->structureDecisionForGlobalActors(),
            $campus->id,
            'Central Branch',
            new CarbonImmutable('2026-02-01'),
            RandomIdentifier::new(),
        );

        $this->assertDatabaseHas('branches', ['id' => $outcome['id'], 'lifecycle_state' => 'draft']);
        $assignment = CampusAssignment::query()->where('branch_id', $outcome['id'])->firstOrFail();
        $this->assertSame($campus->id, $assignment->campus_id);
        $this->assertSame('2026-02-01', $assignment->effective_from);
        $this->assertNull($assignment->effective_to);
        $this->assertSame(2, AuditEvent::query()->where('target_id', $outcome['id'])->count());
    }

    public function test_department_creation_scopes_the_unit_to_its_structural_owner(): void
    {
        $organization = $this->establishActiveOrganization();
        $campus = $this->establishActiveCampus($organization);
        $branch = $this->establishActiveBranch($campus);

        $outcome = $this->createCommand()->createDepartment(
            $this->structureDecisionForGlobalActors(),
            'branch',
            $branch->id,
            'Academic Department',
            RandomIdentifier::new(),
        );

        $this->assertDatabaseHas('departments', [
            'id' => $outcome['id'],
            'scope_type' => 'branch',
            'scope_id' => $branch->id,
            'lifecycle_state' => 'draft',
        ]);
    }

    public function test_rename_records_before_and_after_states(): void
    {
        $organization = $this->establishActiveOrganization('Previous Name');

        $outcome = app(RenameStructureUnit::class)->rename(
            $organization,
            'The TOEFL House',
            $this->structureDecisionForGlobalActors(),
            RandomIdentifier::new(),
        );

        $this->assertSame('The TOEFL House', $outcome['name']);
        $this->assertDatabaseHas('organizations', ['id' => $organization->id, 'name' => 'The TOEFL House']);
        $this->assertDatabaseHas('audit_events', [
            'operation' => 'organization.structure.rename',
            'target_type' => 'organization',
            'target_id' => $organization->id,
            'before_state' => json_encode(['name' => 'Previous Name']),
            'after_state' => json_encode(['name' => 'The TOEFL House']),
        ]);
    }

    public function test_rename_to_the_same_name_is_a_business_rejection(): void
    {
        $organization = $this->establishActiveOrganization('Stable Name');

        $this->expectException(BusinessRejection::class);
        app(RenameStructureUnit::class)->rename($organization, 'Stable Name', $this->structureDecisionForGlobalActors(), RandomIdentifier::new());
    }

    public function test_duplicate_campus_names_inside_one_organization_are_rejected(): void
    {
        $organization = $this->establishActiveOrganization();
        $this->establishActiveCampus($organization, 'Main Campus');

        $this->expectException(QueryException::class);
        $this->createCommand()->createCampus($this->structureDecisionForGlobalActors(), $organization->id, 'Main Campus', RandomIdentifier::new());
    }
}
