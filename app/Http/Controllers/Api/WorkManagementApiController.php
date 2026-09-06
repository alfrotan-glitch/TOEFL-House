<?php

declare(strict_types=1);

namespace App\Http\Controllers\Api;

use App\Http\Controllers\Controller;
use App\Modules\WorkManagement\Commands\MaintainQueueMembership;
use App\Modules\WorkManagement\Commands\MaintainWorkItem;
use App\Modules\WorkManagement\Models\QueueMembership;
use App\Modules\WorkManagement\Models\WorkItem;
use App\Modules\WorkManagement\Queries\WorkItemQuery;
use Illuminate\Http\JsonResponse;
use Illuminate\Http\Request;

/** Coordination transport; linked domain actions remain separate commands. */
final class WorkManagementApiController extends Controller
{
    public function __construct(
        private readonly WorkItemQuery $items,
        private readonly MaintainWorkItem $maintain,
        private readonly MaintainQueueMembership $memberships,
    ) {}

    public function index(): JsonResponse
    {
        return response()->json(['data' => ['items' => $this->items->forActor($this->actor())]]);
    }

    public function transition(Request $request, string $workItemId): JsonResponse
    {
        $toState = trim((string) $request->input('to_state', ''));
        $workItem = WorkItem::query()->whereKey($workItemId)->firstOrFail();
        $result = $this->maintain->transition(
            $this->actor(),
            $workItem,
            $toState,
            $this->idempotencyKey('workflow.work.transition'),
            $request->input('note') === null ? null : trim((string) $request->input('note')),
        );

        return response()->json(['data' => $result]);
    }

    public function grantQueueMembership(Request $request): JsonResponse
    {
        $result = $this->memberships->grant(
            $this->actor(),
            trim((string) $request->input('actor_id', '')),
            trim((string) $request->input('queue_key', '')),
            $request->input('branch_id') === null ? null : trim((string) $request->input('branch_id')),
            $this->idempotencyKey('workflow.queue.grant'),
            $request->input('organization_id') === null ? null : trim((string) $request->input('organization_id')),
        );

        return response()->json(['data' => $result], 201);
    }

    public function revokeQueueMembership(string $membershipId): JsonResponse
    {
        $membership = QueueMembership::query()->whereKey($membershipId)->firstOrFail();

        return response()->json(['data' => $this->memberships->revoke($this->actor(), $membership, $this->idempotencyKey('workflow.queue.revoke'))]);
    }
}
