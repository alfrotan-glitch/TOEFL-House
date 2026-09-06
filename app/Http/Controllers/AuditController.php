<?php

declare(strict_types=1);

namespace App\Http\Controllers;

use App\Modules\Audit\Models\AuditEvent;
use Illuminate\Http\Request;
use Illuminate\View\View;

/**
 * Audit &amp; Governance console: the immutable audit trail. Read-only —
 * events are append-only and cannot be filtered into a different truth,
 * only viewed.
 */
final class AuditController extends Controller
{
    public function index(Request $request): View
    {
        $this->requireOrganizationRead('governance.config', 'audit.console.index');
        $operation = trim((string) $request->query('operation', ''));
        $actorId = trim((string) $request->query('actor_id', ''));
        $targetType = trim((string) $request->query('target_type', ''));

        $organizationIds = $this->authorizedOrganizations('governance.config');
        $branchIds = $this->authorizedBranches('governance.config');
        $applyScope = static function ($query) use ($organizationIds, $branchIds): void {
            $query->where(function ($scope) use ($organizationIds, $branchIds): void {
                $hasMatch = false;
                foreach ($organizationIds as $organizationId) {
                    $method = $hasMatch ? 'orWhere' : 'where';
                    $scope->{$method}(function ($organization) use ($organizationId): void {
                        $organization->whereRaw("after_state->>'organization_id' = ?", [$organizationId])
                            ->orWhereRaw("before_state->>'organization_id' = ?", [$organizationId])
                            ->orWhere(function ($target) use ($organizationId): void {
                                $target->where('target_type', 'organization')->where('target_id', $organizationId);
                            });
                    });
                    $hasMatch = true;
                }
                foreach ($branchIds as $branchId) {
                    $method = $hasMatch ? 'orWhere' : 'where';
                    $scope->{$method}(function ($branch) use ($branchId): void {
                        $branch->whereRaw("after_state->>'branch_id' = ?", [$branchId])
                            ->orWhereRaw("before_state->>'branch_id' = ?", [$branchId])
                            ->orWhere(function ($target) use ($branchId): void {
                                $target->where('target_type', 'branch')->where('target_id', $branchId);
                            });
                    });
                    $hasMatch = true;
                }
                if (! $hasMatch) {
                    $scope->whereRaw('1 = 0');
                }
            });
        };

        $query = AuditEvent::query()->orderByDesc('occurred_at');
        $applyScope($query);
        if ($operation !== '') {
            $query->where('operation', $operation);
        }
        if ($actorId !== '') {
            $query->where('actor_id', $actorId);
        }
        if ($targetType !== '') {
            $query->where('target_type', $targetType);
        }
        $operationsQuery = AuditEvent::query();
        $applyScope($operationsQuery);

        return view('audit.index', [
            'events' => $query->limit(300)->get(),
            'operation' => $operation,
            'actorId' => $actorId,
            'targetType' => $targetType,
            'operations' => $operationsQuery->orderBy('operation')->distinct()->limit(200)->pluck('operation')->all(),
        ]);
    }
}
