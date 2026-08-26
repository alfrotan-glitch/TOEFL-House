<?php

use App\Http\Middleware\EnsureEmployeeSession;
use App\Http\Middleware\SecurityHeaders;
use App\Support\Errors\DomainError;
use Illuminate\Foundation\Application;
use Illuminate\Foundation\Configuration\Exceptions;
use Illuminate\Foundation\Configuration\Middleware;
use Illuminate\Http\Request;

return Application::configure(basePath: dirname(__DIR__))
    ->withRouting(
        web: __DIR__.'/../routes/web.php',
        api: __DIR__.'/../routes/api.php',
        commands: __DIR__.'/../routes/console.php',
        health: '/up',
    )
    ->withMiddleware(function (Middleware $middleware): void {
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

            return redirect()->back()->withInput()->with('error_code', $error->errorCode())->with('error', $error->getMessage());
        });
    })->create();
