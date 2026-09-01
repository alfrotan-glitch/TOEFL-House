<?php

use App\Http\Middleware\EnsureEmployeeSession;
use App\Http\Middleware\SecurityHeaders;
use App\Support\Errors\DomainError;
use Illuminate\Cookie\Middleware\AddQueuedCookiesToResponse;
use Illuminate\Cookie\Middleware\EncryptCookies;
use Illuminate\Foundation\Application;
use Illuminate\Foundation\Configuration\Exceptions;
use Illuminate\Foundation\Configuration\Middleware;
use Illuminate\Foundation\Http\Middleware\ValidateCsrfToken;
use Illuminate\Http\Request;
use Illuminate\Session\Middleware\StartSession;
use Illuminate\View\Middleware\ShareErrorsFromSession;

return Application::configure(basePath: dirname(__DIR__))
    ->withRouting(
        web: __DIR__.'/../routes/web.php',
        api: __DIR__.'/../routes/api.php',
        commands: __DIR__.'/../routes/console.php',
        health: '/up',
    )
    ->withMiddleware(function (Middleware $middleware): void {
        // The employee API (routes/api.php) is same-origin and
        // session-authenticated, exactly like the console: the comment on the
        // route file states "Session-authenticated (same-origin)" and the
        // 'employee' guard reads the authenticated session actor. The default
        // Laravel `api` group is token-only (SubstituteBindings alone) and never
        // starts a session, so over real HTTP the session cookie was neither
        // decrypted nor read and every /api call returned 401 even after a
        // successful console sign-in. Give the API group the same stateful
        // stack the web group runs (cookies + session + CSRF), then rebind
        // route model bindings. CSRF remains enforced for state-changing calls
        // via the X-XSRF-TOKEN header, matching the console.
        $middleware->api(prepend: [
            EncryptCookies::class,
            AddQueuedCookiesToResponse::class,
            StartSession::class,
            ShareErrorsFromSession::class,
            ValidateCsrfToken::class,
        ]);

        // Baseline security headers on every response (web + API). The web
        // server (deploy/nginx) sets the same headers for static assets.
        $middleware->append(SecurityHeaders::class);

        $middleware->alias([
            'employee' => EnsureEmployeeSession::class,
        ]);
    })
    ->withExceptions(function (Exceptions $exceptions): void {
        $exceptions->shouldRenderJsonWhen(
            fn (Request $request, Throwable $e) => $request->expectsJson() || str_starts_with($request->path(), 'api/'),
        );

        // The domain error taxonomy is the single authoritative mapping from a
        // stable business outcome to a transport response. Registered in the
        // exception handler — the final authority — so every DomainError is
        // mapped whether or not a route-level middleware intercepts it first.
        $exceptions->renderable(function (DomainError $error, Request $request) {
            $payload = [
                'error' => $error->errorCode(),
                'category' => $error->category(),
                'message' => $error->getMessage(),
                'correlation_id' => $error->correlationId(),
                'retryable' => $error->retryable(),
            ];
            $status = match ($error->category()) {
                DomainError::CATEGORY_VALIDATION => 422,
                DomainError::CATEGORY_AUTHORIZATION => 403,
                DomainError::CATEGORY_BUSINESS_REJECTION => 409,
                DomainError::CATEGORY_CONCURRENCY_CONFLICT => 409,
                DomainError::CATEGORY_INTEGRATION_UNKNOWN => 502,
                default => 500,
            };

            if ($request->expectsJson() || str_starts_with($request->path(), 'api/')) {
                return response()->json($payload, $status);
            }

            // For the server-rendered console, return the employee to the page
            // they came from so the flash error_code is shown in place. When a
            // state-changing request carries no Referer (programmatic /
            // same-origin API-style clients), redirect()->back() resolves to the
            // "previous URL" the framework stored in the session — which for a
            // freshly signed-in employee is the LOGIN page — ejecting an
            // already-authenticated user and discarding the governed rejection.
            // In that case an authenticated employee goes to the console home
            // (an anonymous request, which the employee guard would not have let
            // reach a command anyway, goes to login).
            $hasReferer = $request->headers->get('referer') !== null;
            if (! $hasReferer) {
                $target = $request->user() !== null ? route('home') : route('login');

                return redirect($target)
                    ->withInput()
                    ->with('error_code', $error->errorCode())
                    ->with('error', $error->getMessage());
            }

            return redirect()
                ->back()
                ->withInput()
                ->with('error_code', $error->errorCode())
                ->with('error', $error->getMessage());
        });
    })->create();
