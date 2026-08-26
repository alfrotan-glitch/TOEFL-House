<?php

declare(strict_types=1);

namespace App\Http\Middleware;

use App\Modules\Identity\Models\Person;
use App\Modules\Identity\Models\UserAccount;
use App\Support\Authorization\Actor;
use Closure;
use Illuminate\Http\Request;
use Illuminate\Support\Facades\Auth;
use Symfony\Component\HttpFoundation\Response;

/**
 * Employee session guard: the authenticated user account must be active, and
 * the request's actor (person identity behind the session) is bound for the
 * controller layer. Authority is never decided here — every operation still
 * resolves through the canonical access model by the server policy decision.
 */
final class EnsureEmployeeSession
{
    public function handle(Request $request, Closure $next): Response
    {
        if (! Auth::check() || ! $request->user()->isActive()) {
            if ($request->expectsJson() || str_starts_with($request->path(), 'api/')) {
                return response()->json(['error' => 'authentication_required', 'message' => 'Sign in as an employee to continue.'], 401);
            }
            if ($request->user() !== null && ! $request->user()->isActive()) {
                Auth::logout();
            }

            return redirect()->route('login');
        }

        $request->attributes->set('actor', $this->actorFor($request));

        return $next($request);
    }

    private function actorFor(Request $request): Actor
    {
        /** @var UserAccount $account */
        $account = $request->user();
        /** @var Person|null $person */
        $person = Person::query()->whereKey($account->person_id)->first();

        return new Actor($account->person_id, $person === null ? $account->username : $person->legal_name);
    }
}
