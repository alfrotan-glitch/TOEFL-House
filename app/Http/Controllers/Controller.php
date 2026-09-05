<?php

declare(strict_types=1);

namespace App\Http\Controllers;

use App\Modules\Audit\AttemptedOperation;
use App\Support\Authorization\Actor;
use App\Support\Authorization\ActorBranches;
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

    /** @return list<string> */
    protected function visibleBranches(): array
    {
        return app(ActorBranches::class)->visibleBranchIds($this->actor());
    }

    protected function hasReadAuthority(): bool
    {
        return app(ActorBranches::class)->hasAnyAuthority($this->actor());
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
