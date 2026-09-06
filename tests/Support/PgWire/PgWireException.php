<?php

declare(strict_types=1);

namespace Tests\Support\PgWire;

use PDOException;

/**
 * PDO-compatible exception carrying the PostgreSQL SQLSTATE.
 *
 * Mirrors the shape pdo_pgsql produces (code + errorInfo[SQLSTATE, SQLSTATE, message])
 * so Illuminate's QueryException handling behaves identically.
 */
final class PgWireException extends PDOException
{
    public function __construct(string $sqlstate, string $message)
    {
        parent::__construct($message);
        $this->code = $sqlstate;
        $this->errorInfo = [$sqlstate, $sqlstate, $message];
    }
}
