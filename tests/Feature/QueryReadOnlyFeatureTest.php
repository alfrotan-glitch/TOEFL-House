<?php

declare(strict_types=1);

namespace Tests\Feature;

use App\Modules\Identity\Commands\VerifyPerson;
use App\Modules\Identity\Models\Person;
use App\Modules\Identity\Queries\PersonDirectoryQuery;
use App\Modules\Organization\Queries\EffectiveStructureQuery;
use App\Support\Authorization\StructureScope;
use App\Support\Identifiers\RandomIdentifier;
use Carbon\CarbonImmutable;
use Illuminate\Support\Facades\DB;
use Tests\Concerns\BuildsActors;
use Tests\Concerns\OperatesStructure;
use Tests\TestCase;

final class QueryReadOnlyFeatureTest extends TestCase
{
    use BuildsActors;
    use OperatesStructure;

    public function test_queries_never_mutate_the_authoritative_facts(): void
    {
        $organization = $this->establishActiveOrganization();
        $campus = $this->establishActiveCampus($organization);
        $branch = $this->establishActiveBranch($campus);

        /** @var Person $person */
        $person = Person::query()->create([
            'id' => RandomIdentifier::new(),
            'legal_name' => 'Queried Person',
            'date_of_birth' => '1992-02-02',
            'verification_state' => Person::VERIFICATION_UNVERIFIED,
        ]);
        app(VerifyPerson::class)->verify($this->identityVerifier(), $person, 'national-id-read', 'documents/national-id-read', RandomIdentifier::new());

        $before = $this->rowCounts();
        $structure = (new EffectiveStructureQuery)->effectiveStructure(new CarbonImmutable('2026-08-25'));
        $directory = (new PersonDirectoryQuery)->personDetail($person->id);
        $verified = (new PersonDirectoryQuery)->verifiedPersons();
        $after = $this->rowCounts();

        $this->assertSame($before, $after);
        $this->assertSame($organization->id, $structure['organizations'][0]['id'] ?? null);
        $this->assertSame('Queried Person', $directory['legal_name'] ?? null);
        $this->assertNotEmpty($verified);
        $this->assertSame('branch', $this->unitTypeOf($structure['branches'], $branch->id));
    }

    public function test_scope_filtered_structure_returns_only_the_scoped_subtree(): void
    {
        $inScope = $this->establishActiveOrganization('In Scope Organization');
        $this->establishActiveOrganization('Out Of Scope Organization');
        $campus = $this->establishActiveCampus($inScope, 'Scoped Campus');

        $result = (new EffectiveStructureQuery)->effectiveStructure(
            new CarbonImmutable('2026-08-25'),
            new StructureScope($inScope->id),
        );

        $this->assertCount(1, $result['organizations']);
        $this->assertSame('In Scope Organization', $result['organizations'][0]['name']);
        $this->assertSame('Scoped Campus', $result['campuses'][0]['name'] ?? null);
    }

    /**
     * @return array<string, int>
     */
    private function rowCounts(): array
    {
        return [
            'organizations' => DB::table('organizations')->count(),
            'campuses' => DB::table('campuses')->count(),
            'branches' => DB::table('branches')->count(),
            'departments' => DB::table('departments')->count(),
            'campus_assignments' => DB::table('campus_assignments')->count(),
            'people' => DB::table('people')->count(),
            'audit_events' => DB::table('audit_events')->count(),
        ];
    }

    /**
     * @param  list<array<string, mixed>>  $rows
     */
    private function unitTypeOf(array $rows, string $id): ?string
    {
        foreach ($rows as $row) {
            if ($row['id'] === $id) {
                return 'branch';
            }
        }

        return null;
    }
}
