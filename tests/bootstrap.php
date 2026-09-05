<?php

declare(strict_types=1);

/*
 * PHPUnit bootstrap.
 *
 * Loads the Composer autoloader, then the sandbox database bootstrap (a no-op
 * wherever the native pdo_pgsql driver is available).
 */

require __DIR__.'/../vendor/autoload.php';

// Defensive base path for environments where the composer loader registry is
// unavailable (Application::inferBasePath falls back to it). Identical to the
// path Composer inference would resolve.
$_ENV['APP_BASE_PATH'] ??= dirname(__DIR__);
$_SERVER['APP_BASE_PATH'] ??= dirname(__DIR__);

if (! extension_loaded('pdo_pgsql')) {
    require_once __DIR__.'/Support/PgWire/bootstrap.php';
}
