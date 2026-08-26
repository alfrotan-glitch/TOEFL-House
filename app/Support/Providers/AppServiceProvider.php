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
        // Print documents carry the organization/branch identity in a shared
        // header. Resolved once per render from the authoritative structure.
        View::composer('print.*', function ($view): void {
            /** @var Organization|null $organization */
            $organization = Organization::query()->where('lifecycle_state', 'active')->orderBy('name')->first();
            /** @var Branch|null $branch */
            $branch = Branch::query()->where('lifecycle_state', 'active')->orderBy('name')->first();

            $view->with('orgIdentity', [
                'name' => $organization === null ? config('app.name', 'The TOEFL House') : $organization->name,
                'branch' => $branch?->name,
            ]);
        });
    }
}
