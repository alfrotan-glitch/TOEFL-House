<?php

declare(strict_types=1);

namespace App\Modules\Reporting\Domain;

use App\Modules\Academic\Models\ClassModel;
use App\Modules\Finance\Models\FundingSource;
use App\Modules\Organization\Models\Branch;
use App\Modules\Organization\Models\Campus;
use App\Modules\Organization\Models\Organization;
use App\Modules\Students\Models\Student;
use App\Support\Authorization\AccessDecision;
use App\Support\Authorization\Actor;
use App\Support\Authorization\StructureScope;
use App\Support\Errors\AuthorizationDenied;
use App\Support\Errors\BusinessRejection;
use Illuminate\Database\Eloquent\ModelNotFoundException;

/**
 * Resolves reporting target provenance before a calculator is allowed to run.
 *
 * Reporting stores organization provenance for every target-bound slice.
 * Student and class scopes resolve through their owning branch; a fund scope
 * resolves through the immutable Finance funding-source owner. A report
 * capability without target authorization is not enough: otherwise a user
 * authorized for one organization could request another organization's
 * student, class, or monetary fund by identifier.
 */
final class ReportingScope
{
    public function __construct(private readonly AccessDecision $access) {}

    /**
     * @return string|null Current organization provenance for every
     *                    target-bound scope; null is reserved exclusively for
     *                    global/institution-wide scope.
     */
    public function authorize(Actor $actor, string $capability, string $scopeType, ?string $scopeId): ?string
    {
        if ($scopeType === 'global') {
            return null;
        }
        if ($scopeType === 'fund') {
            return $this->fundOrganizationId($actor, $capability, $scopeId);
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
        $campusId = trim((string) $scope->campusId);
        if ($organizationId === '' || $campusId === ''
            || ! Campus::query()->whereKey($campusId)->where('organization_id', $organizationId)->where('lifecycle_state', 'active')->exists()
            || ! Organization::query()->whereKey($organizationId)->where('lifecycle_state', 'active')->exists()) {
            throw BusinessRejection::forCode('reporting.scope_unknown', 'the reporting scope requires active campus and organization provenance');
        }
        if (! $this->access->decide($actor, $capability, $scope)->allowed) {
            throw AuthorizationDenied::forCode('reporting.scope_denied', 'the actor is not authorized for the reporting target scope');
        }

        return $organizationId;
    }

    /**
     * Finance owns the source's organization assignment. Legacy sources that
     * predate that immutable provenance are intentionally not guessed at:
     * they cannot authorize, compute, run, or reconcile a tenant report.
     */
    private function fundOrganizationId(Actor $actor, string $capability, ?string $fundId): string
    {
        if ($fundId === null || trim($fundId) === '') {
            throw BusinessRejection::forCode('reporting.scope_unknown', 'the reporting fund scope requires a funding source identifier');
        }
        /** @var FundingSource|null $fund */
        $fund = FundingSource::query()->whereKey($fundId)->first();
        $organizationId = trim((string) ($fund?->organization_id ?? ''));
        if ($fund === null || $organizationId === '' || ! Organization::query()
            ->whereKey($organizationId)
            ->where('lifecycle_state', 'active')
            ->exists()) {
            throw BusinessRejection::forCode('reporting.scope_unknown', 'the reporting fund scope requires an active funding-source organization provenance');
        }

        if (! $this->access->decide($actor, $capability, StructureScope::organization($organizationId))->allowed) {
            throw AuthorizationDenied::forCode('reporting.scope_denied', 'the actor is not authorized for the funding source organization');
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
