<?php

declare(strict_types=1);

namespace App\Modules\Workspace\Queries;

use App\Modules\Academic\Models\ClassModel;
use App\Modules\Finance\Models\FinancialGateException;
use App\Modules\Reporting\Domain\MetricCatalog;
use App\Modules\Reporting\Models\ReportRun;
use App\Modules\Organization\Models\Branch;
use App\Modules\Organization\Models\Campus;
use App\Modules\Organization\Models\Organization;
use App\Modules\Students\Models\Student;
use App\Support\Authorization\AccessDecision;
use App\Support\Authorization\Actor;
use App\Support\Authorization\StructureScope;
use Carbon\CarbonImmutable;
use Illuminate\Database\Eloquent\ModelNotFoundException;
use Illuminate\Support\Facades\DB;

/**
 * Management decision-support composition over governed projections and
 * explicit exception sources. It returns no writable dashboard state and
 * never treats a KPI as a business fact.
 */
final class ManagementWorkspaceQuery
{
    /**
     * @param  list<string>  $visibleBranches
     * @return array<string, mixed>
     */
    public function snapshot(Actor $actor, bool $organizationScope, array $visibleBranches): array
    {
        $scope = $organizationScope ? 'organization' : 'branch';
        $metrics = array_map(static function (string $key): array {
            $entry = MetricCatalog::entry($key);

            return [
                'key' => $key,
                'owner' => $entry['owner'],
                'period_authority' => $entry['authority'],
                'allowed_scopes' => $entry['scopes'],
                'value_status' => 'read_from_reporting_projection',
            ];
        }, MetricCatalog::keys());

        /** @var list<string> $organizationIds */
        $organizationIds = $organizationScope ? $this->authorizedOrganizations($actor) : [];
        // Organization authority must include every active branch in the
        // authorized organization, not only branches returned by the
        // branch-visibility resolver. This preserves organization-wide
        // reporting when a valid organization grant has no branch grant.
        /** @var list<string> $scopedBranches */
        $scopedBranches = $organizationScope
            ? $this->branchesForOrganizations($organizationIds)
            : $visibleBranches;
        sort($scopedBranches);
        /** @var array<string, string> $branchOrganizations */
        $branchOrganizations = $this->branchOrganizations($scopedBranches);
        $counts = $organizationScope
            ? $this->organizationCounts($scopedBranches, $organizationIds, $branchOrganizations)
            : $this->scopedCounts($scopedBranches, $branchOrganizations);

        // These operational tables currently lack organization provenance.
        // Never present platform-wide counts as organization-local health.
        $health = [
            'status' => $organizationScope
                ? 'not_available_without_organization_provenance'
                : 'organization_scope_required_for_operational_health',
            'source_policy' => 'metric reconciliation, integration delivery, and domain-event health remain platform-scoped until provenance is modeled',
        ];

        $latestReports = $organizationScope
            ? ReportRun::query()
                // Global report runs lack an organization key, so only
                // branch-scoped runs with explicit visible provenance enter
                // this multi-organization workspace projection.
                ->where('scope_type', 'branch')
                ->where(function ($scope) use ($branchOrganizations): void {
                    if ($branchOrganizations === []) {
                        $scope->whereRaw('1 = 0');
                        return;
                    }
                    $first = true;
                    foreach ($branchOrganizations as $branchId => $organizationId) {
                        $method = $first ? 'where' : 'orWhere';
                        $scope->{$method}(function ($pair) use ($branchId, $organizationId): void {
                            $pair->where('scope_id', $branchId)->where('organization_id', $organizationId);
                        });
                        $first = false;
                    }
                })
                ->orderByDesc('created_at')->limit(10)->get([
                'id', 'metric_version_id', 'period_key', 'scope_type', 'scope_id', 'organization_id', 'result', 'completeness', 'reproducibility_hash', 'created_at',
            ])->map(static function ($run): array {
                $completeness = $run->completeness;
                $evidenceStatus = $completeness === 'complete'
                    ? 'complete'
                    : ($completeness === 'incomplete' ? 'incomplete' : 'historic_unclassified');

                return [
                    'id' => (string) $run->id,
                    'metric_version_id' => (string) $run->metric_version_id,
                    'period_key' => (string) $run->period_key,
                    'scope_type' => (string) $run->scope_type,
                    'scope_id' => $run->scope_id,
                    'organization_id' => $run->organization_id,
                    // A retained result is not displayable operational truth
                    // when its source cohort was incomplete (or predates the
                    // completeness classification). Never leak it through the
                    // workspace after Reporting intentionally withheld it.
                    'result' => $completeness === 'complete' ? (string) $run->result : null,
                    'completeness' => $completeness,
                    'evidence_status' => $evidenceStatus,
                    'reproducibility_hash' => (string) $run->reproducibility_hash,
                    'created_at' => optional($run->created_at)->toIso8601String(),
                ];
            })->values()->all()
            : [];

        return [
            'actor' => ['id' => $actor->actorId, 'display_name' => $actor->displayName],
            'scope' => ['type' => $scope, 'organization_ids' => $organizationIds, 'branch_ids' => $scopedBranches],
            'metrics' => $metrics,
            'counts' => $counts,
            'operational_health' => $health,
            'latest_reports' => $latestReports,
            'source_policy' => 'all values are governed read projections; mutations remain in owning domains',
            'generated_at' => CarbonImmutable::now()->toIso8601String(),
        ];
    }

    /**
     * @param  list<string>  $branchIds
     * @param  list<string>  $organizationIds
     * @param  array<string, string>  $branchOrganizations
     * @return array<string, int>
     */
    private function organizationCounts(array $branchIds, array $organizationIds, array $branchOrganizations): array
    {
        if ($branchIds === [] && $organizationIds === []) {
            return $this->emptyCounts();
        }

        return [
            'students' => Student::query()
                ->where(function ($query) use ($branchIds): void {
                    $query->whereIn('current_home_branch_id', $branchIds)
                        ->orWhere(function ($fallback) use ($branchIds): void {
                            $fallback->whereNull('current_home_branch_id')->whereIn('originating_branch_id', $branchIds);
                        });
                })
                ->count(),
            'classes' => ClassModel::query()->whereIn('branch_id', $branchIds)->count(),
            'pending_financial_gate_exceptions' => DB::table('financial_gate_exceptions as fge')
                ->join('students as s', 's.id', '=', 'fge.student_id')
                ->where('fge.lifecycle_state', FinancialGateException::STATE_PROPOSED)
                ->where(function ($query) use ($branchIds): void {
                    $query->whereIn('s.current_home_branch_id', $branchIds)
                        ->orWhere(function ($fallback) use ($branchIds): void {
                            $fallback->whereNull('s.current_home_branch_id')->whereIn('s.originating_branch_id', $branchIds);
                        });
                })
                ->count(),
            'held_payroll_calculations' => DB::table('payroll_calculations as pc')
                ->join('employments as e', 'e.id', '=', 'pc.employment_id')
                ->join('people as p', 'p.id', '=', 'e.person_id')
                ->where('pc.lifecycle_state', 'held')
                ->whereIn('p.home_branch_id', $branchIds)
                ->count(),
            'pending_admission_reviews' => DB::table('admission_decisions as ad')
                ->join('applicants as a', 'a.id', '=', 'ad.applicant_id')
                ->whereIn('ad.lifecycle_state', ['proposed', 'reviewed'])
                ->where(function ($query) use ($branchIds): void {
                    $query->whereIn('a.current_home_branch_id', $branchIds)
                        ->orWhere(function ($fallback) use ($branchIds): void {
                            $fallback->whereNull('a.current_home_branch_id')->whereIn('a.originating_branch_id', $branchIds);
                        });
                })
                ->count(),
            'open_work_items' => $this->countWorkItems($organizationIds, $branchOrganizations),
        ];
    }

    /**
     * @param  list<string>  $organizationIds
     * @return list<string>
     */
    private function branchesForOrganizations(array $organizationIds): array
    {
        if ($organizationIds === []) {
            return [];
        }

        $branches = [];
        foreach (Branch::query()->where('lifecycle_state', 'active')->get() as $branch) {
            $assignment = $branch->activeCampusAssignment();
            if ($assignment === null) {
                continue;
            }
            $campus = Campus::query()
                ->whereKey($assignment->campus_id)
                ->where('lifecycle_state', 'active')
                ->first();
            if ($campus === null) {
                continue;
            }
            $organizationId = trim((string) $campus->organization_id);
            if ($organizationId !== '' && in_array($organizationId, $organizationIds, true)) {
                $branches[] = (string) $branch->id;
            }
        }
        sort($branches);

        return $branches;
    }

    /**
     * @param  list<string>  $branchIds
     * @return array<string, string>
     */
    private function branchOrganizations(array $branchIds): array
    {
        if ($branchIds === []) {
            return [];
        }

        $organizations = [];
        foreach (Branch::query()->whereIn('id', $branchIds)->get() as $branch) {
            try {
                $scope = $branch->structureScope();
            } catch (ModelNotFoundException) {
                continue;
            }
            $organizationId = trim((string) $scope->organizationId);
            if ($organizationId !== '') {
                $organizations[(string) $branch->id] = $organizationId;
            }
        }

        return $organizations;
    }

    /**
     * @param  list<string>  $organizationIds
     * @param  array<string, string>  $branchOrganizations
     */
    private function countWorkItems(array $organizationIds, array $branchOrganizations): int
    {
        return (int) DB::table('work_items')
            ->whereIn('lifecycle_state', ['open', 'claimed', 'in_progress'])
            ->where(function ($scope) use ($organizationIds, $branchOrganizations): void {
                $hasCondition = false;
                if ($organizationIds !== []) {
                    $scope->where(function ($organization) use ($organizationIds): void {
                        $organization->whereNull('branch_id')->whereIn('organization_id', $organizationIds);
                    });
                    $hasCondition = true;
                }
                foreach ($branchOrganizations as $branchId => $organizationId) {
                    $method = $hasCondition ? 'orWhere' : 'where';
                    $scope->{$method}(function ($branch) use ($branchId, $organizationId): void {
                        $branch->where('branch_id', $branchId)->where('organization_id', $organizationId);
                    });
                    $hasCondition = true;
                }
                if (! $hasCondition) {
                    $scope->whereRaw('1 = 0');
                }
            })
            ->count();
    }

    /** @return list<string> */
    private function authorizedOrganizations(Actor $actor): array
    {
        $decision = app(AccessDecision::class);
        $authorized = [];
        foreach (Organization::query()->where('lifecycle_state', 'active')->get(['id']) as $organization) {
            if ($decision->decide($actor, 'reporting.run', StructureScope::organization((string) $organization->id))->allowed) {
                $authorized[] = (string) $organization->id;
            }
        }
        sort($authorized);

        return $authorized;
    }

    /** @return array<string, int> */
    private function emptyCounts(): array
    {
        return [
            'students' => 0,
            'classes' => 0,
            'pending_financial_gate_exceptions' => 0,
            'held_payroll_calculations' => 0,
            'pending_admission_reviews' => 0,
            'open_work_items' => 0,
        ];
    }

    /**
     * @param  list<string>  $branchIds
     * @param  array<string, string>  $branchOrganizations
     * @return array<string, int>
     */
    private function scopedCounts(array $branchIds, array $branchOrganizations): array
    {
        if ($branchIds === []) {
            return $this->emptyCounts();
        }

        return [
            'students' => Student::query()
                ->where(function ($query) use ($branchIds): void {
                    $query->whereIn('current_home_branch_id', $branchIds)
                        ->orWhere(function ($fallback) use ($branchIds): void {
                            $fallback->whereNull('current_home_branch_id')->whereIn('originating_branch_id', $branchIds);
                        });
                })
                ->count(),
            'classes' => ClassModel::query()->whereIn('branch_id', $branchIds)->count(),
            'pending_financial_gate_exceptions' => DB::table('financial_gate_exceptions as fge')
                ->join('students as s', 's.id', '=', 'fge.student_id')
                ->where('fge.lifecycle_state', FinancialGateException::STATE_PROPOSED)
                ->where(function ($query) use ($branchIds): void {
                    $query->whereIn('s.current_home_branch_id', $branchIds)
                        ->orWhere(function ($fallback) use ($branchIds): void {
                            $fallback->whereNull('s.current_home_branch_id')->whereIn('s.originating_branch_id', $branchIds);
                        });
                })
                ->count(),
            // Payroll and admission decisions have no branch provenance in the
            // current schema. Fail closed rather than leak global counts.
            'held_payroll_calculations' => 0,
            'pending_admission_reviews' => 0,
            'open_work_items' => $this->countWorkItems([], $branchOrganizations),
        ];
    }
}
