<?php

declare(strict_types=1);

/*
 * Sandbox database bootstrap.
 *
 * The sandbox PHP binary is statically linked, so it cannot load pdo_pgsql.
 * When the pgsql PDO driver is unavailable, this file registers a pure-PHP
 * PostgreSQL wire-protocol driver (PgWirePdo) for the `pgsql` connection via
 * Illuminate's connection resolver. Parameter handling, placeholder rewriting,
 * and result typing mirror pdo_pgsql semantics.
 *
 * When pdo_pgsql IS available this file is a no-op and the native driver is
 * used untouched.
 */

use Illuminate\Database\Connection;
use Illuminate\Database\PostgresConnection;
use Tests\Support\PgWire\PgWirePdo;

require_once __DIR__.'/PgWireException.php';
require_once __DIR__.'/PgWirePdo.php';
require_once __DIR__.'/PgWireStatement.php';

if (! class_exists(Connection::class)) {
    require dirname(__DIR__, 3).'/vendor/autoload.php';
}

if (! extension_loaded('pdo_pgsql') && Connection::getResolver('pgsql') === null) {
    Connection::resolverFor('pgsql', function ($connection, $database, $prefix, $config) {
        $config = is_array($config) ? $config : [];
        $host = (string) ($config['host'] ?? '127.0.0.1');
        $port = (string) ($config['port'] ?? '5432');
        $dbname = str_replace("'", "\\'", (string) ($config['database'] ?? ''));
        $pdo = new PgWirePdo(
            "pgsql:host={$host};port={$port};dbname='{$dbname}'",
            (string) ($config['username'] ?? 'postgres'),
            (string) ($config['password'] ?? ''),
            [PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION]
        );

        // Parity with PostgresConnector::configureSearchPath().
        if (! empty($config['search_path'])) {
            $paths = is_array($config['search_path'])
                ? implode(', ', $config['search_path'])
                : (string) $config['search_path'];
            $pdo->exec('set search_path to '.$paths);
        }

        return new PostgresConnection($pdo, $database, $prefix, $config);
    });
}
