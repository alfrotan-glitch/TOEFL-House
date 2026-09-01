<?php

declare(strict_types=1);

namespace App\Support\Providers;

use App\Modules\Access\AccessResolution;
use App\Modules\Integrations\Adapters\ConfiguredTransportDispatcher;
use App\Modules\Integrations\Domain\SignatureVerifier;
use App\Modules\Integrations\Domain\Transport;
use App\Modules\Organization\Models\Branch;
use App\Modules\Organization\Models\Organization;
use App\Support\Authorization\AccessDecision;
use Illuminate\Cache\RateLimiting\Limit;
use Illuminate\Http\Request;
use Illuminate\Support\Facades\RateLimiter;
use Illuminate\Support\Facades\View;
use Illuminate\Support\ServiceProvider;

final class AppServiceProvider extends ServiceProvider
{
    public function register(): void
    {
        $this->app->singleton(AccessDecision::class, AccessResolution::class);
        $this->app->singleton(Transport::class, fn (): ConfiguredTransportDispatcher => new ConfiguredTransportDispatcher((array) config('integrations.transports')));
        $this->app->singleton(SignatureVerifier::class, fn (): SignatureVerifier => new SignatureVerifier((array) config('integrations.secrets')));
    }

    public function boot(): void
    {
        // Brute-force protection on employee sign-in: a small per-(IP,
        // username) allowance per minute. Backed by the default cache store —
        // the persistent (database) store in production so the limit holds
        // across PHP-FPM workers; the array store in tests.
        RateLimiter::for('login', function (Request $request): Limit {
            $key = 'login|'.$request->ip().'|'.mb_strtolower((string) $request->input('username'));

            return Limit::perMinute(5)->by($key);
        });

        // Print documents carry the organization/branch identity in a shared
        // header, resolved once per render from the authoritative structure.
        //
        // Identity rule (data authority — one source of truth): business
        // records are institution-level (no record is branch-scoped), so the
        // header states the institution: the SINGLE active organization,
        // and — when the institution operates a single active branch — that
        // branch. With zero or multiple active candidates the document is
        // institution-branded (config app.name / no branch line) rather than
        // picking an arbitrary candidate: an official document must never
        // carry a header the structure does not uniquely determine.
        View::composer('print.*', function ($view): void {
            $organizations = Organization::query()->where('lifecycle_state', 'active')->get();
            $branches = Branch::query()->where('lifecycle_state', 'active')->get();

            $view->with('orgIdentity', [
                'name' => $organizations->count() === 1 ? (string) $organizations->first()?->name : config('app.name', 'The TOEFL House'),
                'branch' => $branches->count() === 1 ? $branches->first()?->name : null,
            ]);
        });
    }
}
