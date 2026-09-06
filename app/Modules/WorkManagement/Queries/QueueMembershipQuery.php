<?php

declare(strict_types=1);

namespace App\Modules\WorkManagement\Queries;

use App\Modules\Organization\Models\Branch;
use App\Modules\WorkManagement\Models\QueueMembership;
use App\Support\Authorization\Actor;
use Carbon\CarbonImmutable;
use Illuminate\Database\Eloquent\ModelNotFoundException;

/** Queue membership is explicit and time-bounded; absent membership denies claim. */
final class QueueMembershipQuery
{
    /** @return list<string> */
    public function activeQueueKeys(Actor $actor, ?string $branchId = null, ?string $organizationId = null): array
    {
        $branchId = $branchId === null ? null : trim($branchId);
        $organizationId = $organizationId === null ? null : trim($organizationId);
        if (($branchId === null || $branchId === '') && ($organizationId === null || $organizationId === '')) {
            // A queue lookup without an explicit organization or branch scope
            // would otherwise become a cross-organization membership wildcard.
            return [];
        }
        if ($branchId !== null && $branchId !== '') {
            /** @var Branch|null $branch */
            $branch = Branch::query()->whereKey($branchId)->first();
            if ($branch === null || $branch->lifecycle_state !== 'active' || $organizationId === null || $organizationId === '') {
                return [];
            }
            try {
                $scope = $branch->structureScope();
            } catch (ModelNotFoundException) {
                return [];
            }
            if (trim($scope->organizationId) !== $organizationId) {
                return [];
            }
        }
        $now = CarbonImmutable::now();
        $query = QueueMembership::query()
            ->where('actor_id', $actor->actorId)
            ->where('lifecycle_state', 'active')
            ->where('effective_from', '<=', $now)
            ->where(fn ($scope) => $scope->whereNull('effective_to')->orWhere('effective_to', '>', $now));
        if ($branchId === null || trim($branchId) === '') {
            $query->whereNull('branch_id');
        } else {
            $organizationId = $organizationId === null ? '' : trim($organizationId);
            if ($organizationId === '') {
                $query->whereRaw('1 = 0');
            } else {
                $query->where(function ($scope) use ($branchId, $organizationId): void {
                    $scope->where(function ($branch) use ($branchId, $organizationId): void {
                        $branch->where('branch_id', $branchId)->where('organization_id', $organizationId);
                    })->orWhere(fn ($global) => $global->whereNull('branch_id')->where('organization_id', $organizationId));
                });
            }
        }
        if (($branchId === null || trim($branchId) === '') && $organizationId !== null && trim($organizationId) !== '') {
            $query->where('organization_id', trim($organizationId));
        }

        return $query->pluck('queue_key')->map(static fn ($key): string => trim((string) $key))->filter()->unique()->values()->all();
    }

    public function canClaim(Actor $actor, string $queueKey, ?string $branchId, ?string $organizationId): bool
    {
        return in_array(trim($queueKey), $this->activeQueueKeys($actor, $branchId, $organizationId), true);
    }
}
