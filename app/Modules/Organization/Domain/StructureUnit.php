<?php

declare(strict_types=1);

namespace App\Modules\Organization\Domain;

use App\Support\Authorization\StructureScope;

/**
 * Common surface of the organization aggregate units sharing the
 * organization lifecycle and audit vocabulary.
 */
interface StructureUnit
{
    public function unitId(): string;

    public function unitType(): string;

    public function unitName(): string;

    public function lifecycleState(): string;

    public function structureScope(): StructureScope;
}
