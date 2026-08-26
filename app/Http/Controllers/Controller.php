<?php

declare(strict_types=1);

namespace App\Http\Controllers;

use App\Support\Authorization\Actor;
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

    protected function idempotencyKey(string $operation): string
    {
        $supplied = (string) (request()->header('Idempotency-Key') ?? request()->input('idempotency_key', ''));
        if (preg_match('/^[A-Za-z0-9._:-]{8,128}$/', $supplied) === 1) {
            return $supplied;
        }

        return $operation.'-'.bin2hex(random_bytes(12));
    }
}
