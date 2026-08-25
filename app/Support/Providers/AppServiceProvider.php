<?php

declare(strict_types=1);

namespace App\Support\Providers;

use App\Modules\Access\AccessResolution;
use App\Support\Authorization\AccessDecision;
use Illuminate\Support\ServiceProvider;

final class AppServiceProvider extends ServiceProvider
{
    public function register(): void
    {
        $this->app->singleton(AccessDecision::class, AccessResolution::class);
    }

    public function boot(): void {}
}
