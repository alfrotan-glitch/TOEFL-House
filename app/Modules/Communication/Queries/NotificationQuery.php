<?php

declare(strict_types=1);

namespace App\Modules\Communication\Queries;

use App\Modules\Communication\Models\Notification;
use App\Modules\Organization\Models\Branch;
use App\Modules\Organization\Models\Organization;
use App\Support\Authorization\AccessDecision;
use App\Support\Authorization\Actor;
use App\Support\Authorization\ActorBranches;
use App\Support\Authorization\StructureScope;
use Carbon\CarbonImmutable;
use Illuminate\Database\Eloquent\ModelNotFoundException;

/** Recipient-scoped notification read projection; no global notification feed. */
final class NotificationQuery
{
    /** @return array{status: string, unread_count: int, items: list<array<string, mixed>>} */
    public function forActor(Actor $actor, int $limit = 50): array
    {
        $now = CarbonImmutable::now();
        $candidateBranches = app(ActorBranches::class)->visibleBranchIds($actor);
        /** @var list<string> $branches */
        $branches = $this->authorizedBranches($actor, $candidateBranches);
        /** @var array<string, string> $branchOrganizations */
        $branchOrganizations = $this->branchOrganizations($branches);
        // Resolve organization scope directly through AccessResolution rather
        // than inferring it from visible branches. An organization grant is a
        // real branchless authority and remains valid when an organization has
        // no current campus/branch assignment; null branch is never a wildcard.
        $organizationIds = $this->authorizedOrganizations($actor);
        $scope = static function ($query) use ($organizationIds, $branchOrganizations): void {
            $query->where(function ($scope) use ($organizationIds, $branchOrganizations): void {
                $hasCondition = false;
                if ($organizationIds !== []) {
                    $scope->where(function ($organization) use ($organizationIds): void {
                        $organization->where('scope_type', 'organization')->whereIn('organization_id', $organizationIds);
                    });
                    $hasCondition = true;
                }
                foreach ($branchOrganizations as $branchId => $organizationId) {
                    $method = $hasCondition ? 'orWhere' : 'where';
                    $scope->{$method}(function ($branch) use ($branchId, $organizationId): void {
                        $branch->where('scope_type', 'branch')
                            ->where('branch_id', $branchId)
                            ->where('organization_id', $organizationId);
                    });
                    $hasCondition = true;
                }
                if (! $hasCondition) {
                    $scope->whereRaw('1 = 0');
                }
            });
        };
        $items = array_values(Notification::query()
            ->where('recipient_actor_id', $actor->actorId)
            ->where($scope)
            ->whereIn('lifecycle_state', ['unread', 'read'])
            ->where(fn ($query) => $query->whereNull('expires_at')->orWhere('expires_at', '>', $now))
            ->orderByRaw("CASE WHEN lifecycle_state = 'unread' THEN 0 ELSE 1 END")
            ->orderByDesc('created_at')
            ->limit(max(1, min($limit, 100)))
            ->get(['id', 'source_type', 'source_id', 'title', 'body_ref', 'severity', 'scope_type', 'organization_id', 'branch_id', 'lifecycle_state', 'read_at', 'created_at'])
            ->map(static fn (Notification $notification): array => [
                'id' => (string) $notification->id,
                'source_type' => (string) $notification->source_type,
                'source_id' => (string) $notification->source_id,
                'title' => (string) $notification->title,
                'body_ref' => $notification->body_ref,
                'severity' => (string) $notification->severity,
                'scope_type' => (string) $notification->scope_type,
                'organization_id' => $notification->organization_id,
                'branch_id' => $notification->branch_id,
                'status' => (string) $notification->lifecycle_state,
                'read_at' => $notification->read_at?->toIso8601String(),
                'created_at' => $notification->created_at?->toIso8601String(),
            ])->values()->all());

        return [
            'status' => 'ready',
            'unread_count' => Notification::query()
                ->where('recipient_actor_id', $actor->actorId)
                ->where($scope)
                ->where('lifecycle_state', 'unread')
                ->where(fn ($query) => $query->whereNull('expires_at')->orWhere('expires_at', '>', $now))
                ->count(),
            'items' => $items,
        ];
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

    /** @return list<string> */
    private function authorizedOrganizations(Actor $actor): array
    {
        $decision = app(AccessDecision::class);
        $authorized = [];
        foreach (Organization::query()->where('lifecycle_state', 'active')->get(['id']) as $organization) {
            if ($decision->decide($actor, 'communication.notification.read', StructureScope::organization((string) $organization->id))->allowed) {
                $authorized[] = (string) $organization->id;
            }
        }
        sort($authorized);

        return $authorized;
    }

    /**
     * @param  list<string>  $candidateBranchIds
     * @return list<string>
     */
    private function authorizedBranches(Actor $actor, array $candidateBranchIds): array
    {
        $decision = app(AccessDecision::class);
        $authorized = [];
        foreach (Branch::query()->whereIn('id', $candidateBranchIds)->get() as $branch) {
            if ($decision->decide($actor, 'communication.notification.read', $branch->structureScope())->allowed) {
                $authorized[] = (string) $branch->id;
            }
        }
        sort($authorized);

        return $authorized;
    }
}
