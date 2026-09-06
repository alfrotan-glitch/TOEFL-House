<?php

declare(strict_types=1);

namespace App\Modules\Reporting\Domain;

use App\Modules\Academic\Models\ClassModel;
use App\Modules\Organization\Models\Branch;
use App\Modules\Students\Models\Student;
use App\Support\Authorization\AccessDecision;
use App\Support\Authorization\Actor;
use App\Support\Errors\AuthorizationDenied;
use App\Support\Errors\BusinessRejection;
use Illuminate\Database\Eloquent\ModelNotFoundException;

/**
 * Resolves reporting target provenance before a calculator is allowed to run.
 *
 * Reporting stores branch organization provenance for branch slices, but
 * student and class slices also need to be re-resolved through their owning
 * records. A report capability without target authorization is not enough:
 * otherwise a user authorized for one branch could request another student's
 * or class's slice by identifier.
 */
final class ReportingScope
{
    public function __construct(private readonly AccessDecision $access) {}

    /**
     * @return string|null Current organization provenance for branch-backed
     *                    scopes; null is reserved for global/institution-wide
     *                    scopes.
     */
    public function authorize(Actor $actor, string $capability, string $scopeType, ?string $scopeId): ?string
    {
        if ($scopeType === 'global' || $scopeType === 'fund') {
            return null;
        }

        $branchId = match ($scopeType) {
            'branch' => $scopeId,
            'student' => $this->studentBranchId($scopeId),
            'class' => $this->classBranchId($scopeId),
            default => throw BusinessRejection::forCode('reporting.scope_type_unknown', 'the reporting scope type has no provenance resolver'),
        };
        if ($branchId === null || trim($branchId) === '') {
            throw BusinessRejection::forCode('reporting.scope_unknown', 'the reporting scope requires current branch provenance');
        }

        /** @var Branch|null $branch */
        $branch = Branch::query()->whereKey($branchId)->first();
        if ($branch === null || $branch->lifecycle_state !== 'active') {
            throw BusinessRejection::forCode('reporting.scope_unknown', 'the reporting scope requires an active branch');
        }
        try {
            $scope = $branch->structureScope();
        } catch (ModelNotFoundException) {
            throw BusinessRejection::forCode('reporting.scope_unknown', 'the reporting scope requires current active campus provenance');
        }
        $organizationId = trim((string) $scope->organizationId);
        if ($organizationId === '') {
            throw BusinessRejection::forCode('reporting.scope_unknown', 'the reporting scope requires active organization provenance');
        }
        if (! $this->access->decide($actor, $capability, $scope)->allowed) {
            throw AuthorizationDenied::forCode('reporting.scope_denied', 'the actor is not authorized for the reporting target scope');
        }

        return $organizationId;
    }

    private function studentBranchId(?string $studentId): ?string
    {
        if ($studentId === null || trim($studentId) === '') {
            return null;
        }
        /** @var Student|null $student */
        $student = Student::query()->whereKey($studentId)->first();
        if ($student === null) {
            throw BusinessRejection::forCode('reporting.scope_unknown', 'the reporting student scope does not exist');
        }

        return trim((string) ($student->current_home_branch_id ?: $student->originating_branch_id)) ?: null;
    }

    private function classBranchId(?string $classId): ?string
    {
        if ($classId === null || trim($classId) === '') {
            return null;
        }
        /** @var ClassModel|null $class */
        $class = ClassModel::query()->whereKey($classId)->first();
        if ($class === null) {
            throw BusinessRejection::forCode('reporting.scope_unknown', 'the reporting class scope does not exist');
        }

        return trim((string) $class->branch_id) ?: null;
    }
}
