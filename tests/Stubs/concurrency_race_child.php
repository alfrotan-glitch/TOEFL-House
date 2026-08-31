<?php

declare(strict_types=1);

/**
 * Concurrency race child (plain CLI — no framework). Invoked by
 * ConcurrencyRaceTest as an independent process with its own PostgreSQL
 * connection. It opens a transaction, signals readiness, then claims the
 * SAME staged approver slots the parent claims, and reports the outcome.
 *
 * argv: db host port user password row_id approver ready_file result_file
 */
[
    , $db, $host, $port, $user, $password, $rowId, $approver, $readyFile, $resultFile,
] = $argv;

$pdo = new PDO(
    sprintf('pgsql:host=%s;port=%s;dbname=%s', $host, $port, $db),
    $user,
    $password,
    [PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION],
);

$pdo->exec('BEGIN');
touch($readyFile);
usleep(500_000);

try {
    $sql = sprintf(
        "UPDATE org_wide_grant_requests
            SET approver_one_id = '%s',
                approver_two_id = '%s-2',
                lifecycle_state = 'approved'
          WHERE id = '%s'",
        $approver,
        $approver,
        $rowId,
    );
    $pdo->exec($sql);
    $pdo->exec('COMMIT');
    file_put_contents($resultFile, 'COMMITTED');
} catch (PDOException $e) {
    $pdo->exec('ROLLBACK');
    file_put_contents($resultFile, 'REJECTED: '.$e->getMessage());
}
