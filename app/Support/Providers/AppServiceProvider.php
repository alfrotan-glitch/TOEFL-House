<?php

declare(strict_types=1);

namespace App\Support\Providers;

use App\Modules\Access\AccessResolution;
use App\Modules\Integrations\Adapters\ConfiguredTransportDispatcher;
use App\Modules\Integrations\Domain\SignatureVerifier;
use App\Modules\Integrations\Domain\Transport;
use App\Support\Authorization\AccessDecision;
use Illuminate\Support\ServiceProvider;

final class AppServiceProvider extends ServiceProvider
{
    public function register(): void
    {
        $this->app->singleton(AccessDecision::class, AccessResolution::class);
        $this->app->singleton(Transport::class, fn (): ConfiguredTransportDispatcher => new ConfiguredTransportDispatcher((array) config('integrations.transports')));
        $this->app->singleton(SignatureVerifier::class, fn (): SignatureVerifier => new SignatureVerifier((array) config('integrations.secrets')));
    }

    public function boot(): void {}
}
