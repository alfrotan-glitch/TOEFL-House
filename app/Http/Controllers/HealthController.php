<?php

declare(strict_types=1);

namespace App\Http\Controllers;

use Illuminate\Support\Facades\DB;
use Symfony\Component\HttpFoundation\Response;

/**
 * Production health/readiness probe (The TOEFL House).
 *
 * `/up` (framework liveness) only proves the app boots. This endpoint proves
 * the deployment is actually operable: the database is reachable and the
 * runtime configuration is valid. It returns 200 when healthy and 503 when a
 * critical dependency is down, so an orchestrator (systemd, nginx, a
 * load balancer, or a deploy script) can gate traffic on it. The body is
 * deliberately minimal and never leaks secrets or connection details.
 */
final class HealthController extends Controller
{
    public function __invoke(): Response
    {
        $checks = ['database' => 'ok', 'application_key' => 'ok'];
        $healthy = true;

        try {
            DB::connection()->select('select 1');
        } catch (\Throwable) {
            $checks['database'] = 'error';
            $healthy = false;
        }

        if (strlen((string) config('app.key')) < 32) {
            $checks['application_key'] = 'error';
            $healthy = false;
        }

        return response()->json([
            'status' => $healthy ? 'ok' : 'error',
            'service' => 'The TOEFL House',
            'environment' => (string) config('app.env'),
            'checks' => $checks,
        ], $healthy ? Response::HTTP_OK : Response::HTTP_SERVICE_UNAVAILABLE);
    }
}
