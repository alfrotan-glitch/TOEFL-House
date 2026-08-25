<?php

declare(strict_types=1);

namespace Tests\Concerns;

use App\Modules\Organization\Commands\CreateStructureUnit;
use App\Modules\Organization\Commands\TransitionStructureUnit;
use App\Modules\Organization\Models\Branch;
use App\Modules\Organization\Models\Campus;
use App\Modules\Organization\Models\Organization;
use App\Support\Authorization\StructureDecision;
use App\Support\Identifiers\RandomIdentifier;
use Carbon\CarbonImmutable;

/**
 * Command-level fixtures: every structure fact in the tests is produced by
 * the production commands themselves, never by direct persistence writes.
 */
trait OperatesStructure
{
    private function structureDecisionForGlobalActors(): StructureDecision
    {
        return new StructureDecision(
            $this->generalManager(),
            $this->structureManager('*'),
            [$this->structureOwner('*', 'owner-1'), $this->structureOwner('*', 'owner-2')],
        );
    }

    private function establishActiveOrganization(string $name = 'TOEFL House'): Organization
    {
        $decision = $this->structureDecisionForGlobalActors();
        $created = $this->createCommand()->createOrganization($decision, $name, RandomIdentifier::new());
        /** @var Organization $organization */
        $organization = Organization::query()->findOrFail($created['id']);
        $this->transitionCommand()->activate($organization, $this->structureDecisionForGlobalActors(), RandomIdentifier::new());

        /** @var Organization $refreshed */
        $refreshed = Organization::query()->findOrFail($organization->id);

        return $refreshed;
    }

    private function establishActiveCampus(Organization $organization, string $name = 'Main Campus'): Campus
    {
        $created = $this->createCommand()->createCampus($this->structureDecisionForGlobalActors(), $organization->id, $name, RandomIdentifier::new());
        /** @var Campus $campus */
        $campus = Campus::query()->findOrFail($created['id']);
        $this->transitionCommand()->activate($campus, $this->structureDecisionForGlobalActors(), RandomIdentifier::new());

        /** @var Campus $refreshed */
        $refreshed = Campus::query()->findOrFail($campus->id);

        return $refreshed;
    }

    private function establishActiveBranch(Campus $campus, string $name = 'Central Branch'): Branch
    {
        $created = $this->createCommand()->createBranch(
            $this->structureDecisionForGlobalActors(),
            $campus->id,
            $name,
            new CarbonImmutable('2026-01-01'),
            RandomIdentifier::new(),
        );
        /** @var Branch $branch */
        $branch = Branch::query()->findOrFail($created['id']);
        $this->transitionCommand()->activate($branch, $this->structureDecisionForGlobalActors(), RandomIdentifier::new());

        /** @var Branch $refreshed */
        $refreshed = Branch::query()->findOrFail($branch->id);

        return $refreshed;
    }

    private function createCommand(): CreateStructureUnit
    {
        return app(CreateStructureUnit::class);
    }

    private function transitionCommand(): TransitionStructureUnit
    {
        return app(TransitionStructureUnit::class);
    }
}
