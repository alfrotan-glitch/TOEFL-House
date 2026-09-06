<?php

declare(strict_types=1);

namespace App\Http\Middleware;

use Closure;
use Illuminate\Http\Request;
use Symfony\Component\HttpFoundation\Response;

/**
 * Baseline security headers for every response. Defense in depth: the same
 * headers are also set at the web server (see deploy/nginx) so they are
 * present even for statically-served assets. These headers constrain how
 * browsers treat the console; they do not substitute for transport security
 * (HTTPS) or authorization, which are enforced elsewhere.
 */
final class SecurityHeaders
{
    public function handle(Request $request, Closure $next): Response
    {
        $response = $next($request);

        $response->headers->set('X-Content-Type-Options', 'nosniff');
        $response->headers->set('X-Frame-Options', 'DENY');
        $response->headers->set('Referrer-Policy', 'strict-origin-when-cross-origin');
        $response->headers->set('Permissions-Policy', 'geolocation=(), microphone=(), camera=(), payment=()');
        // Strict-Transport-Security is meaningful only over HTTPS; the web
        // server is the authoritative place for it (it knows the scheme). We
        // still emit it so a misconfigured direct-to-PHP path is not assumed
        // to be downgradable by a client.
        $response->headers->set('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
        $response->headers->set('Cache-Control', 'no-store');

        return $response;
    }
}
