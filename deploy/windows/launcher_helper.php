<?php

/**
 * Launcher helper for START-TOEFL-HOUSE.bat.
 *
 * The Windows batch layer cannot safely embed complex code:
 *   - Inline `php -r "..."` containing parentheses, called from a parenthesized
 *     `if (...)` block, is mangled by cmd's block parser (PHP reports
 *     "Unclosed '('"), which silently dropped our .env overrides.
 *   - `for /f` over `psql.exe` with quoted paths/SQL is mis-parsed by cmd's
 *     quote/parenthesis rules (the query never executed, so the account count
 *     came back empty and the launcher stopped).
 *
 * This script performs those jobs with plain PHP and exits with a stable,
 * documented code so the launcher can branch on `errorlevel`. It uses only the
 * PDO pdo_pgsql driver (already a hard requirement) and does NOT bootstrap
 * Laravel, so it runs on the raw runtime with no dependencies.
 *
 * Usage (all paths passed by the launcher as absolute arguments):
 *   php launcher_helper.php <command> <arg1> [arg2] ...
 *
 * Commands:
 *   env-set      <envPath> <k=v> [<k=v> ...]
 *                  Rewrites the .env file, replacing each KEY= line with the
 *                  given value and preserving every other line. Exits 0 on
 *                  success, 1 on usage/IO error.
 *   db-exists    <pgsqlDsn> <user> <password> <dbname>
 *                  Prints "yes"/"no". Exits 0 when the database exists, 3 when
 *                  it does not, 2 on a connection/query error.
 *   db-app-valid <pgsqlDsn> <user> <password> <dbname>
 *                  Connects to <dbname> and decides whether it is a TOEFL House
 *                  database by authoritative catalog checks. Prints "valid" and
 *                  exits 0 when it is ours; prints "foreign" and exits 3 when
 *                  it belongs to another application; exits 2 on connect/query
 *                  error.
 *   account-count <pgsqlDsn> <user> <password> <dbname>
 *                  Prints the integer row count of public.user_accounts. Exits
 *                  0 when the count is zero (first run, needs the owner), 1 when
 *                  at least one account exists (nothing to bootstrap), 2 when
 *                  the table is missing or the server cannot be reached.
 *   port-bindable <port>
 *                  Attempts to bind 127.0.0.1:<port> for a moment and closes it.
 *                  Exits 0 when the port can be bound (free, not reserved), 3
 *                  when it cannot be bound (already listening OR inside a
 *                  Windows reserved/excluded port range, e.g. Hyper-V/WinNAT -
 *                  such a port shows no LISTENING entry in netstat), 2 on usage
 *                  error. This distinguishes "netstat says free but bind fails".
 */

declare(strict_types=1);

$argv0 = array_shift($argv); // script path
$command = array_shift($argv);

if ($command === null) {
    fwrite(STDERR, "launcher_helper: no command given\n");
    exit(1);
}

try {
    switch ($command) {
        case 'env-set':
            $envPath = array_shift($argv);
            $pairs = $argv;
            if ($envPath === null || $pairs === []) {
                fwrite(STDERR, "launcher_helper env-set: <envPath> and at least one k=v are required\n");
                exit(1);
            }
            exit(envSet($envPath, $pairs));

        case 'port-bindable':
            $port = (int) array_shift($argv);
            if ($port <= 0 || $port > 65535) {
                fwrite(STDERR, "launcher_helper port-bindable: a TCP port 1-65535 is required\n");
                exit(2);
            }
            exit(portBindable($port));

        case 'db-exists':
        case 'db-app-valid':
        case 'account-count':
            [$dsn, $user, $password, $dbname] = array_pad($argv, 4, null);
            if ($dsn === null || $user === null || $password === null || $dbname === null) {
                fwrite(STDERR, "launcher_helper {$command}: <dsn> <user> <password> <dbname> are required\n");
                exit(2);
            }
            exit(dbCommand($command, $dsn, $user, $password, $dbname));

        default:
            fwrite(STDERR, "launcher_helper: unknown command '{$command}'\n");
            exit(1);
    }
} catch (Throwable $e) {
    fwrite(STDERR, 'launcher_helper: ' . $e->getMessage() . PHP_EOL);
    exit(2);
}

/**
 * Replace KEY= lines in an .env file, preserving all other content.
 * The file is rewritten atomically (temp file + rename).
 */
function envSet(string $envPath, array $pairs): int
{
    if (!is_file($envPath)) {
        fwrite(STDERR, "launcher_helper env-set: .env not found at {$envPath}\n");
        return 1;
    }

    $updates = [];
    foreach ($pairs as $pair) {
        $eq = strpos($pair, '=');
        if ($eq === false) {
            fwrite(STDERR, "launcher_helper env-set: malformed pair (missing '='): {$pair}\n");
            return 1;
        }
        $key = substr($pair, 0, $eq);
        $value = substr($pair, $eq + 1);
        if (!preg_match('/^[A-Za-z_][A-Za-z0-9_]*$/', $key)) {
            fwrite(STDERR, "launcher_helper env-set: bad key in pair: {$pair}\n");
            return 1;
        }
        $updates[$key] = $value;
    }

    $lines = file($envPath, FILE_IGNORE_NEW_LINES);
    if ($lines === false) {
        fwrite(STDERR, "launcher_helper env-set: cannot read {$envPath}\n");
        return 1;
    }

    $out = [];
    $applied = [];
    foreach ($lines as $line) {
        if (preg_match('/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/', $line, $m) === 1 && array_key_exists($m[1], $updates)) {
            $key = $m[1];
            $out[] = $key . '=' . $updates[$key];
            $applied[$key] = true;
        } else {
            $out[] = $line;
        }
    }
    // Any key not present in the template is appended so the override still lands.
    foreach ($updates as $key => $value) {
        if (!isset($applied[$key])) {
            $out[] = $key . '=' . $value;
        }
    }

    $tmp = $envPath . '.tmp';
    if (file_put_contents($tmp, implode(PHP_EOL, $out) . PHP_EOL, LOCK_EX) === false) {
        fwrite(STDERR, "launcher_helper env-set: cannot write {$tmp}\n");
        return 1;
    }
    if (!@rename($tmp, $envPath)) {
        @unlink($tmp);
        fwrite(STDERR, "launcher_helper env-set: cannot replace {$envPath}\n");
        return 1;
    }

    return 0;
}

/**
 * Run one of the database inspection commands. Always opens a fresh PDO
 * connection to the named database (db-exists connects to the maintenance
 * database supplied inside the DSN and checks pg_database).
 */
function dbCommand(string $command, string $dsn, string $user, string $password, string $dbname): int
{
    $pdo = new PDO($dsn, $user, $password, [
        PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION,
        PDO::ATTR_DEFAULT_FETCH_MODE => PDO::FETCH_NUM,
        PDO::ATTR_TIMEOUT => 5,
    ]);

    switch ($command) {
        case 'db-exists':
            $stmt = $pdo->prepare('SELECT 1 FROM pg_database WHERE datname = ?');
            $stmt->execute([$dbname]);
            if ($stmt->fetch() !== false) {
                echo 'yes', PHP_EOL;
                return 0; // present
            }
            echo 'no', PHP_EOL;
            return 3; // absent

        case 'db-app-valid':
            // Authoritative identity checks against the catalog:
            //  - the application root table user_accounts exists, or
            //  - the Laravel migration that creates it is recorded, or
            //  - the database is an empty TOEFL House DB (no application tables
            //    yet - e.g. right after createdb, before the first migrate).
            $hasTable = (int) $pdo->query(
                'SELECT CASE WHEN EXISTS (SELECT 1 FROM information_schema.tables '
                . "WHERE table_schema = 'public' AND table_name = 'user_accounts') THEN 1 ELSE 0 END"
            )->fetchColumn();

            $migrationsClass = $pdo->query("SELECT to_regclass('public.migrations')")->fetchColumn();
            $migrationsExists = $migrationsClass !== null && $migrationsClass !== false;

            $hasMigration = 0;
            if ($migrationsExists) {
                $st = $pdo->prepare('SELECT CASE WHEN EXISTS (SELECT 1 FROM migrations WHERE migration = ?) THEN 1 ELSE 0 END');
                $st->execute(['2026_08_25_000007_create_user_accounts_table']);
                $hasMigration = (int) $st->fetchColumn();
            }

            // Public tables other than Laravel's migrations table. A database
            // belonging to a DIFFERENT program has its own tables here and none
            // of our markers, so it is classified foreign and left untouched.
            $otherTables = (int) $pdo->query(
                'SELECT count(*) FROM information_schema.tables '
                . "WHERE table_schema = 'public' AND table_name <> 'migrations'"
            )->fetchColumn();

            $valid = $hasTable === 1 || $hasMigration === 1 || $otherTables === 0;
            echo $valid ? 'valid' : 'foreign', PHP_EOL;
            return $valid ? 0 : 3; // 0 = ours, 3 = foreign database

        case 'account-count':
            $regclass = $pdo->query("SELECT to_regclass('public.user_accounts')")->fetchColumn();
            if ($regclass === null || $regclass === false) {
                fwrite(STDERR, "launcher_helper: user_accounts table is missing after migration\n");
                return 2;
            }
            $count = (int) $pdo->query('SELECT count(*) FROM public.user_accounts')->fetchColumn();
            echo $count, PHP_EOL;
            // 0 accounts = first run (exit 0); existing accounts = skip bootstrap (exit 1).
            return $count === 0 ? 0 : 1;
    }

    return 2;
}

/**
 * Return 0 when 127.0.0.1:<port> can be used by our server, 3 when it cannot
 * (already listening, or inside an OS reserved/excluded range). A raw socket
 * bind alone is NOT reliable on Windows: stream_socket_server uses
 * SO_REUSEADDR, which lets a test socket bind to a port that is held or inside
 * a Hyper-V/WinNAT excluded range, while the real PHP server's exclusive bind
 * then fails with WSAEACCES. So we first ask Windows (netstat for listeners,
 * netsh for excluded port ranges), and only then try a socket bind. All checks
 * are read-only; netstat/netsh are standard Windows commands.
 */
function portBindable(int $port): int
{
    if (portHasListener($port)) {
        return 3;
    }
    if (portIsInExcludedRange($port)) {
        return 3;
    }

    $errno = 0;
    $errstr = '';
    $sock = @stream_socket_server("tcp://127.0.0.1:{$port}", $errno, $errstr, STREAM_SERVER_BIND | STREAM_SERVER_LISTEN);
    if (is_resource($sock)) {
        fclose($sock);

        return 0;
    }

    return 3;
}

/**
 * True when something is LISTENING on the port (any address). Reads netstat.
 */
function portHasListener(int $port): bool
{
    $out = @shell_exec('netstat -ano 2>nul');
    if (!is_string($out) || $out === '') {
        // Cannot determine via netstat; fall through to the socket test.
        return false;
    }
    // Lines look like:  TCP   127.0.0.1:8080   0.0.0.0:0   LISTENING   1234
    foreach (preg_split('/\r?\n/', $out) as $line) {
        if (stripos($line, 'LISTENING') === false) {
            continue;
        }
        if (preg_match('/:' . $port . '\s/', $line) === 1 || preg_match('/:' . $port . '$/', trim($line)) === 1) {
            return true;
        }
    }

    return false;
}

/**
 * True when the port falls in a Windows reserved/excluded TCP range
 * (Hyper-V / WinNAT / WSL reserve dynamic ranges that nothing can bind).
 */
function portIsInExcludedRange(int $port): bool
{
    $out = @shell_exec('netsh interface ipv4 show excludedportrange protocol=tcp 2>nul');
    if (!is_string($out) || $out === '') {
        return false;
    }
    // Data rows have two numeric columns: start port and end port.
    if (preg_match_all('/^\s*(\d+)\s+(\d+)\s*$/m', $out, $m, PREG_SET_ORDER) === false) {
        return false;
    }
    foreach ($m as $row) {
        $start = (int) $row[1];
        $end = (int) $row[2];
        if ($port >= $start && $port <= $end) {
            return true;
        }
    }

    return false;
}
