<?php

declare(strict_types=1);

namespace App\Modules\WorkManagement\Queries;

use App\Modules\Hr\Domain\EmploymentLifecycle;
use App\Modules\Hr\Models\Employment;
use App\Modules\Organization\Models\Branch;
use App\Modules\Organization\Models\Organization;
use App\Modules\WorkManagement\Models\WorkItem;
use App\Support\Authorization\AccessDecision;
use App\Support\Authorization\Actor;
use App\Support\Authorization\ActorBranches;
use App\Support\Authorization\StructureScope;
use Illuminate\Database\Eloquent\ModelNotFoundException;

/**
 * Fail-closed work discovery. Every projected item has explicit organization
 * provenance and may additionally carry branch provenance; branchless items
 * are organization-scoped rather than globally visible. Assignment or
 * explicit queue membership is a discovery edge, never authorization to
 * execute the linked source command. Queue membership scope is matched to the
 * work item's organization or branch; a null branch is never a wildcard.
 */
final class WorkItemQuery
{
    /** @return list<array<string, mixed>> */
    public function forActor(Actor $actor): array
    {
        $employment = Employment::query()
            ->where('person_id', $actor->actorId)
            ->orderByDesc('created_at')
            ->orderByDesc('id')
            ->first();
        if ($employment === null || $employment->lifecycle_state !== EmploymentLifecycle::STATE_ACTIVE) {
            return [];
        }

        $candidateBranches = array_values(app(ActorBranches::class)->visibleBranchIds($actor));
        $branches = $this->authorizedBranches($actor, $candidateBranches);
        $branchOrganizations = $this->branchOrganizations($branches);
        $organizationIds = $this->authorizedOrganizations($actor);
        $queueMemberships = app(QueueMembershipQuery::class);

        /** @var list<array{organization_id: string, queue_key: string}> $organizationQueues */
        $organizationQueues = [];
        foreach ($organizationIds as $organizationId) {
            foreach ($queueMemberships->activeQueueKeys($actor, null, $organizationId) as $queueKey) {
                $organizationQueues[] = ['organization_id' => $organizationId, 'queue_key' => $queueKey];
            }
        }

        /** @var list<array{branch_id: string, queue_key: string}> $branchQueues */
        $branchQueues = [];
        foreach ($branches as $branchId) {
            /** @var Branch|null $branch */
            $branch = Branch::query()->whereKey($branchId)->first();
            $organizationId = $branch === null ? '' : trim((string) $branch->structureScope()->organizationId);
            if ($organizationId === '') {
                continue;
            }
            foreach ($queueMemberships->activeQueueKeys($actor, $branchId, $organizationId) as $queueKey) {
                $branchQueues[] = ['branch_id' => $branchId, 'queue_key' => $queueKey];
            }
        }

        $query = WorkItem::query()
            ->where(function ($assignment) use ($actor, $organizationQueues, $branchQueues): void {
                $assignment->where('assigned_to', $actor->actorId)
                    ->orWhere(function ($queue) use ($organizationQueues, $branchQueues): void {
                        $queue->whereNull('assigned_to')->where(function ($membership) use ($organizationQueues, $branchQueues): void {
                            if ($organizationQueues === [] && $branchQueues === []) {
                                $membership->whereRaw('1 = 0');
                                return;
                            }
                            foreach ($organizationQueues as $scope) {
                                $membership->orWhere(function ($organization) use ($scope): void {
                                    $organization->where('organization_id', $scope['organization_id'])
                                        ->where('queue_key', $scope['queue_key']);
                                });
                            }
                            foreach ($branchQueues as $scope) {
                                $membership->orWhere(function ($branch) use ($scope): void {
                                    $branch->where('branch_id', $scope['branch_id'])
                                        ->where('queue_key', $scope['queue_key']);
                                });
                            }
                        });
                    });
            })
            ->whereIn('lifecycle_state', ['open', 'claimed', 'in_progress'])
            ->orderBy('priority')
            ->orderBy('due_at');

        $query->where(function ($scope) use ($organizationIds, $branchOrganizations): void {
            $hasCondition = false;
            if ($organizationIds !== []) {
                // Organization-scoped work is branchless. Branch-scoped work
                // must additionally agree with the branch's current
                // organization; a later branch transfer must not turn stale
                // provenance into a newly authorized work item.
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
        });

        return array_values($query->limit(100)->get([
            'id', 'kind', 'title', 'source_type', 'source_id', 'action_key',
            'organization_id', 'branch_id', 'priority', 'due_at', 'lifecycle_state',
        ])->map(static fn (WorkItem $item): array => [
            'organization_id' => $item->organization_id,
            'branch_id' => $item->branch_id,
            'id' => (string) $item->id,
            'kind' => (string) $item->kind,
            'source_type' => (string) $item->source_type,
            'source_id' => (string) $item->source_id,
            'title' => (string) $item->title,
            'status' => (string) $item->lifecycle_state,
            'due_at' => $item->due_at?->toIso8601String(),
            'route' => '/workspace?work_item_id='.(string) $item->id,
            'action_key' => (string) $item->action_key,
        ])->values()->all());
    }

    /**
     * @param list<string> $branchIds
     *
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

    /** @return list<string> */
    private function authorizedOrganizations(Actor $actor): array
    {
        $decision = app(AccessDecision::class);
        $authorized = [];
        foreach (Organization::query()->where('lifecycle_state', 'active')->get(['id']) as $organization) {
            if ($decision->decide($actor, 'workflow.work', StructureScope::organization((string) $organization->id))->allowed) {
                $authorized[] = (string) $organization->id;
            }
        }
        sort($authorized);

        return $authorized;
    }

    /**
     * @param list<string> $candidateBranchIds
     *
     * @return list<string>
     */
    private function authorizedBranches(Actor $actor, array $candidateBranchIds): array
    {
        $decision = app(AccessDecision::class);
        $authorized = [];
        foreach (Branch::query()->whereIn('id', $candidateBranchIds)->get() as $branch) {
            if ($decision->decide($actor, 'workflow.work', $branch->structureScope())->allowed) {
                $authorized[] = (string) $branch->id;
            }
        }
        sort($authorized);

        return $authorized;
    }
}
