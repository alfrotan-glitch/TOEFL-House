<?php

declare(strict_types=1);

namespace App\Http\Controllers;

use App\Modules\Audit\AttemptedOperation;
use App\Support\Authorization\AccessDecision;
use App\Modules\Organization\Models\Branch;
use App\Modules\Organization\Models\Organization;
use App\Support\Authorization\Actor;
use App\Support\Authorization\ActorBranches;
use App\Support\Authorization\StructureScope;
use App\Support\Errors\AuthorizationDenied;
use Illuminate\Foundation\Auth\Access\AuthorizesRequests;
use Illuminate\Foundation\Validation\ValidatesRequests;
use Illuminate\Routing\Controller as BaseController;

/**
 * Base controller for the employee console and API. Controllers are a thin
 * transport boundary: they validate input, resolve the request's actor, and
 * delegate to the module command/query surface. All business rules,
 * authorization, idempotency, and audit remain owned by the authoritative
 * domain commands — never re-implemented here.
 */
abstract class Controller extends BaseController
{
    use AuthorizesRequests, ValidatesRequests;

    protected function actor(): Actor
    {
        /** @var Actor $actor */
        $actor = request()->attributes->get('actor');

        return $actor;
    }

    /**
     * Read-side branch gate (WP-ACAD-SCOPE) for document production and
     * bulk-read endpoints: the target's owning branch must be visible to
     * the actor. Denials are denial-audited and surface as 403. Mutations
     * are never authorized here — commands own those decisions.
     */
    protected function requireBranchVisible(?string $branchId, string $operation, string $targetType, string $targetId, string $errorCode = 'api.read_denied'): void
    {
        if (app(ActorBranches::class)->allows($this->actor(), $branchId)) {
            return;
        }
        app(AttemptedOperation::class)->deniedByActor(
            AuthorizationDenied::forCode($errorCode, 'this record is outside your authorized branches'),
            $this->actor(),
            $operation,
            $targetType,
            $targetId,
        );
    }

    protected function requireBranchCapability(string $capability, ?string $branchId, string $operation, string $targetType, string $targetId): void
    {
        if ($this->branchCapabilityAllowed($capability, $branchId)) {
            return;
        }

        app(AttemptedOperation::class)->deniedByActor(
            AuthorizationDenied::forCode('api.read_denied', 'this record is outside your authorized capability scope'),
            $this->actor(),
            $operation,
            $targetType,
            $targetId,
        );
    }

    protected function branchCapabilityAllowed(string $capability, ?string $branchId): bool
    {
        $branch = $branchId === null ? null : Branch::query()->find($branchId);

        return $branch !== null
            && app(AccessDecision::class)->decide($this->actor(), $capability, $branch->structureScope())->allowed;
    }

    /** @return list<string> */
    protected function visibleBranches(): array
    {
        return app(ActorBranches::class)->visibleBranchIds($this->actor());
    }

    protected function hasReadAuthority(): bool
    {
        return app(ActorBranches::class)->hasAnyAuthority($this->actor());
    }

    /** @return list<string> */
    protected function authorizedBranches(string $capability): array
    {
        $actor = $this->actor();
        $decision = app(AccessDecision::class);
        $authorized = [];

        // Resolve every active branch through the canonical decision point.
        // ActorBranches is a useful navigation hint, but it is not complete
        // authorization input: an organization-root grant may legitimately
        // have no branch rows in that hint set. A branch with missing or
        // inactive temporal provenance is rejected by AccessResolution, so
        // this remains fail-closed for unknown topology.
        foreach (Branch::query()->where('lifecycle_state', 'active')->get() as $branch) {
            if ($decision->decide($actor, $capability, $branch->structureScope())->allowed) {
                $authorized[] = (string) $branch->id;
            }
        }
        sort($authorized);

        return $authorized;
    }

    /** @return list<string> */
    protected function authorizedOrganizations(string $capability): array
    {
        $actor = $this->actor();
        $decision = app(AccessDecision::class);
        $authorized = [];
        foreach (Organization::query()->where('lifecycle_state', 'active')->get(['id']) as $organization) {
            if ($decision->decide($actor, $capability, StructureScope::organization((string) $organization->id))->allowed) {
                $authorized[] = (string) $organization->id;
            }
        }
        sort($authorized);

        return $authorized;
    }

    /**
     * A console that intentionally returns organization-wide records must
     * prove organization-rooted authority; branch visibility is not a
     * wildcard and cannot authorize an unscoped result set.
     */
    protected function requireOrganizationRead(string $capability, string $operation, string $targetType = 'console', string $targetId = 'index'): void
    {
        $outcome = app(AccessDecision::class)->decide($this->actor(), $capability, null);
        if ($outcome->allowed) {
            return;
        }

        app(AttemptedOperation::class)->deniedByActor(
            AuthorizationDenied::forCode('api.organization_read_denied', $outcome->reason),
            $this->actor(),
            $operation,
            $targetType,
            $targetId,
        );
    }

    protected function idempotencyKey(string $operation): string
    {
        $supplied = (string) (request()->header('Idempotency-Key') ?? request()->input('idempotency_key', ''));
        if (preg_match('/^[A-Za-z0-9._:-]{8,128}$/', $supplied) === 1) {
            return $supplied;
        }

        return $operation.'-'.bin2hex(random_bytes(12));
    }
}
