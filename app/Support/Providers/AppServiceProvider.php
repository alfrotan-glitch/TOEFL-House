<?php

declare(strict_types=1);

namespace App\Support\Providers;

use App\Support\Authorization\AccessDecision;
use App\Support\Authorization\AuthorizationGate;
use Illuminate\Support\ServiceProvider;

final class AppServiceProvider extends ServiceProvider
{
    public function register(): void
    {
        $this->app->bind(AccessDecision::class, AuthorizationGate::class);
    }

    public function boot(): void {}
}
