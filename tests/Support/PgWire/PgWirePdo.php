<?php

declare(strict_types=1);

namespace Tests\Support\PgWire;

use DateTimeInterface;
use PDO;
use PDOStatement;
use Stringable;

/**
 * Sandbox-only PostgreSQL PDO implementation over the v3 wire protocol.
 *
 * The sandbox PHP binary is statically linked and cannot load pdo_pgsql, so
 * this pure-PHP driver provides the exact PDO surface Illuminate needs:
 * positional placeholders rewritten (? -> $n, mirroring pdo_pgsql, including
 * the ?? escape), extended-protocol binds with server-side type inference
 * (identical parameter semantics to pdo_pgsql), and pdo_pgsql-compatible
 * result typing by column OID.
 *
 * Only trust/cleartext/md5 authentication is implemented (the sandbox cluster
 * uses trust). Not for production use.
 */
class PgWirePdo extends PDO
{
    private const TYPE_BOOL = 16;

    private const TYPE_BYTEA = 17;

    private const TYPE_INT8 = 20;

    private const TYPE_INT2 = 21;

    private const TYPE_INT4 = 23;

    private const TYPE_FLOAT4 = 700;

    private const TYPE_FLOAT8 = 701;

    private const TYPE_NUMERIC = 1700;

    /** @var resource|null */
    private $socket = null;

    private string $host = '';

    private int $port = 5432;

    private string $serverVersion = '';

    private bool $inTransaction = false;

    private int $errmode = PDO::ERRMODE_EXCEPTION;

    private int $defaultFetchMode = PDO::FETCH_BOTH;

    private int $caseFolding = PDO::CASE_NATURAL;

    private bool $stringifyFetches = false;

    private ?string $errCode = '00000';

    private array $errInfo = ['00000', '', ''];

    /**
     * @param  array<int, mixed>|null  $options
     */
    public function __construct(string $dsn, ?string $username = null, ?string $password = null, ?array $options = null)
    {
        $config = $this->parseDsn($dsn);
        $this->host = (string) ($config['host'] ?? '127.0.0.1');
        $this->port = (int) ($config['port'] ?? 5432);
        $database = (string) ($config['dbname'] ?? $username ?? 'postgres');
        $user = (string) ($username ?? $config['user'] ?? 'postgres');
        $pass = (string) ($password ?? $config['password'] ?? '');
        $timeout = (int) ($config['connect_timeout'] ?? 10);

        $this->open($this->host, $this->port, $timeout);
        $this->startup($database, $user, $pass);

        foreach ($options ?? [] as $attr => $value) {
            $this->setAttribute((int) $attr, $value);
        }
        $this->setError('00000', '');
    }

    // ------------------------------------------------------------------
    // PDO surface
    // ------------------------------------------------------------------

    public function prepare(string $query, array $options = []): PDOStatement|false
    {
        $rewritten = $this->rewritePlaceholders($query);

        return PgWireStatement::create($this, $query, $rewritten, $options);
    }

    public function query(string $query, ?int $fetchMode = null, mixed ...$fetchModeArgs): PDOStatement|false
    {
        $results = $this->simpleQuery($query);
        $first = $results[0] ?? ['fields' => [], 'rows' => [], 'tag' => ''];
        $stmt = PgWireStatement::fromResult($this, $query, $first['fields'], $first['rows'], $first['tag']);
        if ($fetchMode !== null) {
            $stmt->setFetchMode($fetchMode, ...$fetchModeArgs);
        }

        return $stmt;
    }

    public function exec(string $statement): int|false
    {
        $results = $this->simpleQuery($statement);
        $last = end($results);
        if ($last === false) {
            return 0;
        }

        return $this->countFromTag($last['tag'], count($last['rows']), true);
    }

    public function quote(string $string, int $type = PDO::PARAM_STR): string|false
    {
        $escaped = str_replace(['\\', "'"], ['\\\\', "''"], $string);

        return "'".$escaped."'";
    }

    public function beginTransaction(): bool
    {
        if ($this->inTransaction) {
            return $this->fail('There is already an active transaction', '25001');
        }
        $this->simpleQuery('BEGIN');
        $this->inTransaction = true;

        return true;
    }

    public function commit(): bool
    {
        if (! $this->inTransaction) {
            return $this->fail('There is no active transaction', '25001');
        }
        $this->simpleQuery('COMMIT');
        $this->inTransaction = false;

        return true;
    }

    public function rollBack(): bool
    {
        if (! $this->inTransaction) {
            return $this->fail('There is no active transaction', '25001');
        }
        $this->simpleQuery('ROLLBACK');
        $this->inTransaction = false;

        return true;
    }

    public function inTransaction(): bool
    {
        return $this->inTransaction;
    }

    public function errorCode(): ?string
    {
        return $this->errCode;
    }

    public function errorInfo(): array
    {
        return $this->errInfo;
    }

    public function getAttribute(int $attribute): mixed
    {
        return match ($attribute) {
            PDO::ATTR_DRIVER_NAME => 'pgsql',
            PDO::ATTR_SERVER_VERSION, PDO::ATTR_SERVER_INFO => $this->serverVersion,
            PDO::ATTR_CLIENT_VERSION => $this->serverVersion,
            PDO::ATTR_CONNECTION_STATUS => "Connection OK; waiting to send. ({$this->host}:{$this->port})",
            PDO::ATTR_ERRMODE => $this->errmode,
            PDO::ATTR_DEFAULT_FETCH_MODE => $this->defaultFetchMode,
            PDO::ATTR_CASE => $this->caseFolding,
            PDO::ATTR_STRINGIFY_FETCHES => $this->stringifyFetches,
            PDO::ATTR_ORACLE_NULLS => PDO::NULL_NATURAL,
            PDO::ATTR_EMULATE_PREPARES => false,
            default => null,
        };
    }

    public function setAttribute(int $attribute, mixed $value): bool
    {
        match ($attribute) {
            PDO::ATTR_ERRMODE => $this->errmode = (int) $value,
            PDO::ATTR_DEFAULT_FETCH_MODE => $this->defaultFetchMode = (int) $value,
            PDO::ATTR_CASE => $this->caseFolding = (int) $value,
            PDO::ATTR_STRINGIFY_FETCHES => $this->stringifyFetches = (bool) $value,
            PDO::ATTR_TIMEOUT => $this->applyTimeout((int) $value),
            default => null,
        };

        return true;
    }

    public function lastInsertId(?string $name = null): string|false
    {
        return '0';
    }

    // ------------------------------------------------------------------
    // Internals used by PgWireStatement
    // ------------------------------------------------------------------

    /**
     * Execute an extended-protocol prepared statement.
     *
     * @param  array<int, string|null>  $params  already encoded (null = SQL NULL)
     * @return array{fields: array<int, array{name: string, oid: int}>, rows: array<int, array<int, string|null>>, tag: string}
     */
    public function executeExtended(string $sql, array $params): array
    {
        $payload = "\x00".$sql."\x00".pack('n', 0);
        $this->sendMessage('P', $payload);

        $bind = "\x00\x00".pack('n', 0).pack('n', count($params));
        foreach ($params as $value) {
            $bind .= $value === null ? pack('N', 0xFFFFFFFF) : pack('N', strlen($value)).$value;
        }
        $bind .= pack('n', 1).pack('n', 0);
        $this->sendMessage('B', $bind);

        $this->sendMessage('D', 'S'."\x00");
        $this->sendMessage('E', "\x00".pack('N', 0));
        $this->sendMessage('S', '');

        $fields = [];
        $rows = [];
        $tag = '';
        $error = null;

        while (true) {
            [$type, $body] = $this->readMessage();
            switch ($type) {
                case '1': // ParseComplete
                case '2': // BindComplete
                case 't': // ParameterDescription
                case 'n': // NoData
                case '3': // CloseComplete
                    break;
                case 'T':
                    $fields = $this->parseRowDescription($body);
                    break;
                case 'D':
                    $rows[] = $this->parseDataRow($body, count($fields));
                    break;
                case 'C':
                    $tag = rtrim($body, "\x00");
                    break;
                case 'N':
                    break;
                case 'S':
                    $this->captureParameterStatus($body);
                    break;
                case 'E':
                    $error ??= $this->parseError($body);
                    break;
                case 'Z':
                    $this->trackTransactionStatus($body);
                    if ($error !== null) {
                        throw new PgWireException($error[0], $error[1]);
                    }

                    return ['fields' => $fields, 'rows' => $rows, 'tag' => $tag];
                default:
                    $this->poison("unexpected message '{$type}' during extended query");
            }
        }
    }

    public function defaultFetchMode(): int
    {
        return $this->defaultFetchMode;
    }

    public function caseFolding(): int
    {
        return $this->caseFolding;
    }

    public function stringifyFetches(): bool
    {
        return $this->stringifyFetches;
    }

    /**
     * Convert a raw text value using the column type, mirroring pdo_pgsql.
     */
    public function convertValue(?string $value, int $oid): mixed
    {
        if ($value === null) {
            return null;
        }
        if ($this->stringifyFetches) {
            return $value;
        }

        return match ($oid) {
            self::TYPE_BOOL => $value === 't',
            self::TYPE_INT2, self::TYPE_INT4, self::TYPE_INT8 => (int) $value,
            self::TYPE_FLOAT4, self::TYPE_FLOAT8 => (float) $value,
            self::TYPE_BYTEA => $this->decodeBytea($value),
            default => $value,
        };
    }

    /**
     * Encode a bound PHP value to the text-format bytes for Bind.
     *
     * @return string|null null means SQL NULL
     */
    public function encodeParam(mixed $value): ?string
    {
        if ($value === null) {
            return null;
        }
        if (is_bool($value)) {
            return $value ? '1' : '0';
        }
        if (is_int($value) || is_float($value)) {
            if (is_float($value) && (is_infinite($value) || is_nan($value))) {
                throw new PgWireException('22000', 'cannot encode non-finite float as a query parameter');
            }

            return (string) $value;
        }
        if ($value instanceof DateTimeInterface) {
            return $value->format('Y-m-d H:i:s');
        }
        if (is_resource($value)) {
            $contents = stream_get_contents($value);

            return $contents === false ? null : '\x'.bin2hex($contents);
        }
        if ($value instanceof Stringable || is_string($value)) {
            return (string) $value;
        }

        // Let PHP raise the natural conversion error (parity with PDO).
        return (string) $value;
    }

    // ------------------------------------------------------------------
    // Simple protocol (exec/query/transaction control)
    // ------------------------------------------------------------------

    /**
     * @return list<array{fields: array<int, array{name: string, oid: int}>, rows: array<int, array<int, string|null>>, tag: string}>
     */
    private function simpleQuery(string $sql): array
    {
        $this->sendMessage('Q', $sql."\x00");

        $results = [];
        $fields = [];
        $rows = [];
        $hasResult = false;
        $error = null;

        while (true) {
            [$type, $body] = $this->readMessage();
            switch ($type) {
                case 'T':
                    $fields = $this->parseRowDescription($body);
                    $rows = [];
                    $hasResult = true;
                    break;
                case 'D':
                    $rows[] = $this->parseDataRow($body, count($fields));
                    break;
                case 'C':
                    $results[] = ['fields' => $fields, 'rows' => $rows, 'tag' => rtrim($body, "\x00")];
                    $fields = [];
                    $rows = [];
                    $hasResult = false;
                    break;
                case 'I':
                    $results[] = ['fields' => [], 'rows' => [], 'tag' => ''];
                    break;
                case 'N':
                    break;
                case 'S':
                    // Reportable GUCs (search_path, TimeZone, ...) echo back on SET.
                    $this->captureParameterStatus($body);
                    break;
                case 'E':
                    $error ??= $this->parseError($body);
                    break;
                case 'Z':
                    $this->trackTransactionStatus($body);
                    if ($error !== null) {
                        throw new PgWireException($error[0], $error[1]);
                    }

                    return $results;
                default:
                    $this->poison("unexpected message '{$type}' during simple query");
            }
        }
    }

    // ------------------------------------------------------------------
    // Placeholder rewriting (? -> $n, mirroring pdo_pgsql)
    // ------------------------------------------------------------------

    public function rewritePlaceholders(string $sql): string
    {
        $out = '';
        $n = 0;
        $len = strlen($sql);
        $i = 0;
        while ($i < $len) {
            $c = $sql[$i];
            $next = $i + 1 < $len ? $sql[$i + 1] : '';
            if ($c === "'") {
                $out .= $c;
                $i++;
                while ($i < $len) {
                    $out .= $sql[$i];
                    if ($sql[$i] === "'") {
                        if ($i + 1 < $len && $sql[$i + 1] === "'") {
                            $out .= "'";
                            $i += 2;

                            continue;
                        }
                        $i++;
                        break;
                    }
                    if ($sql[$i] === '\\') {
                        if ($i + 1 < $len) {
                            $out .= $sql[$i + 1];
                            $i += 2;

                            continue;
                        }
                    }
                    $i++;
                }

                continue;
            }
            if ($c === '"') {
                $out .= $c;
                $i++;
                while ($i < $len) {
                    $out .= $sql[$i];
                    if ($sql[$i] === '"') {
                        if ($i + 1 < $len && $sql[$i + 1] === '"') {
                            $out .= '"';
                            $i += 2;

                            continue;
                        }
                        $i++;
                        break;
                    }
                    $i++;
                }

                continue;
            }
            if ($c === '-' && $next === '-') {
                while ($i < $len && $sql[$i] !== "\n") {
                    $out .= $sql[$i];
                    $i++;
                }

                continue;
            }
            if ($c === '/' && $next === '*') {
                $out .= '/*';
                $i += 2;
                while ($i < $len && ! ($sql[$i] === '*' && $i + 1 < $len && $sql[$i + 1] === '/')) {
                    $out .= $sql[$i];
                    $i++;
                }
                $out .= '*/';
                $i += 2;

                continue;
            }
            if ($c === '$') {
                $rest = substr($sql, $i);
                if (preg_match('/^\$[A-Za-z_][A-Za-z0-9_]*\$|^\$\$/', $rest, $m) === 1) {
                    $tag = $m[0];
                    $close = strpos($sql, $tag, $i + strlen($tag));
                    $end = $close === false ? $len : $close + strlen($tag);
                    $out .= substr($sql, $i, $end - $i);
                    $i = $end;

                    continue;
                }
                $out .= $c;
                $i++;

                continue;
            }
            if ($c === '?') {
                if ($next === '?') {
                    // pdo_pgsql escape: ?? is a literal ? operator.
                    $out .= '?';
                    $i += 2;

                    continue;
                }
                if ($next === '|' || $next === '&') {
                    $out .= '?'.$next;
                    $i += 2;

                    continue;
                }
                $n++;
                $out .= '$'.$n;
                $i++;

                continue;
            }
            if ($c === ':') {
                if ($next === ':') {
                    $out .= '::';
                    $i += 2;

                    continue;
                }
                if ($next !== '' && (ctype_alpha($next) || $next === '_')) {
                    throw new PgWireException('HY000', 'named parameters (:name) are not supported by the pgsql driver; use positional ? placeholders');
                }
                $out .= $c;
                $i++;

                continue;
            }
            $out .= $c;
            $i++;
        }

        return $out;
    }

    // ------------------------------------------------------------------
    // Connection plumbing
    // ------------------------------------------------------------------

    private function parseDsn(string $dsn): array
    {
        $config = [];
        $rest = str_starts_with($dsn, 'pgsql:') ? substr($dsn, 6) : $dsn;
        foreach (explode(';', $rest) as $part) {
            $part = trim($part);
            if ($part === '' || ! str_contains($part, '=')) {
                continue;
            }
            [$key, $value] = explode('=', $part, 2);
            $value = trim($value);
            if (strlen($value) >= 2 && str_starts_with($value, "'") && str_ends_with($value, "'")) {
                $value = stripslashes(substr($value, 1, -1));
            }
            $config[trim($key)] = $value;
        }

        return $config;
    }

    /**
     * @throws PgWireException
     */
    private function open(string $host, int $port, int $timeout): void
    {
        $address = str_starts_with($host, '/')
            ? 'unix://'.rtrim($host, '/').'/.s.PGSQL.'.$port
            : 'tcp://'.$host.':'.$port;
        $errno = 0;
        $errstr = '';
        $socket = @stream_socket_client($address, $errno, $errstr, max(1, $timeout));
        if ($socket === false) {
            throw new PgWireException('08006', "connection to server at \"{$host}\", port {$port} failed: {$errstr}");
        }
        stream_set_blocking($socket, true);
        stream_set_timeout($socket, 60);
        // Disable Nagle: the extended protocol sends several small frames per
        // query, and delayed-ACK would otherwise add ~40ms per frame.
        if (function_exists('socket_import_stream')) {
            $sock = @socket_import_stream($socket);
            if ($sock !== false) {
                @socket_set_option($sock, SOL_TCP, TCP_NODELAY, 1);
                unset($sock);
            }
        }
        $this->socket = $socket;
    }

    private function applyTimeout(int $seconds): void
    {
        if (is_resource($this->socket) && $seconds > 0) {
            stream_set_timeout($this->socket, $seconds);
        }
    }

    /**
     * @throws PgWireException
     */
    private function startup(string $database, string $user, string $password): void
    {
        $payload = pack('N', 196608)
            .'user'."\x00".$user."\x00"
            .'database'."\x00".$database."\x00"
            .'client_encoding'."\x00".'UTF8'."\x00"
            .'application_name'."\x00".'pgwire-laravel'."\x00"
            ."\x00";
        $this->write(pack('N', strlen($payload) + 4).$payload);

        while (true) {
            [$type, $body] = $this->readMessage();
            switch ($type) {
                case 'R':
                    $this->authenticate($body, $user, $password);
                    break;
                case 'S':
                    $this->captureParameterStatus($body);
                    break;
                case 'K':
                    break;
                case 'N':
                    break;
                case 'E':
                    [$code, $message] = $this->parseError($body);
                    throw new PgWireException($code, 'connection failed: '.$message);
                case 'Z':
                    $this->trackTransactionStatus($body);

                    return;
                default:
                    $this->poison("unexpected message '{$type}' during startup");
            }
        }
    }

    /**
     * @throws PgWireException
     */
    private function authenticate(string $body, string $user, string $password): void
    {
        $kind = unpack('N', substr($body, 0, 4))[1];
        if ($kind === 0) {
            return;
        }
        if ($kind === 3) {
            $this->sendMessage('p', $password."\x00");

            return;
        }
        if ($kind === 5) {
            $salt = substr($body, 4, 4);
            $hash = md5(md5($password.$user).$salt);

            $this->sendMessage('p', 'md5'.$hash."\x00");

            return;
        }
        throw new PgWireException('08004', 'unsupported authentication method requested by the server');
    }

    private function captureParameterStatus(string $body): void
    {
        $parts = explode("\x00", $body);
        if (($parts[0] ?? '') === 'server_version') {
            $this->serverVersion = $parts[1] ?? '';
        }
    }

    private function trackTransactionStatus(string $body): void
    {
        $status = $body[0] ?? 'I';
        $this->inTransaction = $status === 'T' || $status === 'E';
    }

    /**
     * @throws PgWireException
     */
    private function sendMessage(string $type, string $payload): void
    {
        $this->write($type.pack('N', strlen($payload) + 4).$payload);
    }

    /**
     * @throws PgWireException
     */
    private function write(string $bytes): void
    {
        if (! is_resource($this->socket)) {
            throw new PgWireException('08006', 'server closed the connection unexpectedly: no connection to the server');
        }
        $remaining = strlen($bytes);
        $offset = 0;
        while ($remaining > 0) {
            $written = @fwrite($this->socket, substr($bytes, $offset));
            if ($written === false || $written === 0) {
                $this->poison('server closed the connection unexpectedly while sending');

                // @phpstan-ignore deadCode.unreachable
                throw new PgWireException('08006', 'server closed the connection unexpectedly while sending');
            }
            $offset += $written;
            $remaining -= $written;
        }
    }

    /**
     * @return array{0: string, 1: string}
     *
     * @throws PgWireException
     */
    private function readMessage(): array
    {
        $header = $this->readBytes(5);
        $type = $header[0];
        $length = unpack('N', substr($header, 1, 4))[1];
        if ($length < 4) {
            $this->poison('received a malformed message from the server');
        }
        $body = $length > 4 ? $this->readBytes($length - 4) : '';

        return [$type, $body];
    }

    /**
     * @throws PgWireException
     */
    private function readBytes(int $count): string
    {
        if (! is_resource($this->socket)) {
            throw new PgWireException('08006', 'server closed the connection unexpectedly: no connection to the server');
        }
        $buffer = '';
        while (strlen($buffer) < $count) {
            $chunk = @fread($this->socket, $count - strlen($buffer));
            if ($chunk === false || $chunk === '') {
                $meta = stream_get_meta_data($this->socket);
                if (($meta['timed_out'] ?? false) === true) {
                    $this->poison('timed out waiting for the server');
                }
                $this->poison('server closed the connection unexpectedly');
            }
            $buffer .= $chunk;
        }

        return $buffer;
    }

    /**
     * @return array<int, array{name: string, oid: int}>
     */
    private function parseRowDescription(string $body): array
    {
        $offset = 0;
        $count = unpack('n', substr($body, 0, 2))[1];
        $offset = 2;
        $fields = [];
        for ($i = 0; $i < $count; $i++) {
            $end = strpos($body, "\x00", $offset);
            $name = substr($body, $offset, $end - $offset);
            $offset = $end + 1;
            $tableOid = unpack('N', substr($body, $offset, 4))[1];
            $offset += 4;
            $offset += 2; // column attribute number
            $oid = unpack('N', substr($body, $offset, 4))[1];
            $offset += 4;
            $offset += 2; // data type size
            $offset += 4; // type modifier
            $offset += 2; // format code
            unset($tableOid);
            $fields[] = ['name' => $name, 'oid' => $oid];
        }

        return $fields;
    }

    /**
     * @return array<int, string|null>
     */
    private function parseDataRow(string $body, int $columns): array
    {
        $offset = 2;
        $row = [];
        $count = unpack('n', substr($body, 0, 2))[1];
        for ($i = 0; $i < $count; $i++) {
            $length = unpack('N', substr($body, $offset, 4))[1];
            $offset += 4;
            if ($length === 0xFFFFFFFF) {
                $row[] = null;

                continue;
            }
            $row[] = substr($body, $offset, $length);
            $offset += $length;
        }
        while (count($row) < $columns) {
            $row[] = null;
        }

        return $row;
    }

    /**
     * @return array{0: string, 1: string} [sqlstate, message]
     */
    private function parseError(string $body): array
    {
        $code = 'HY000';
        $message = 'unknown server error';
        $detail = '';
        $offset = 0;
        $len = strlen($body);
        while ($offset < $len && $body[$offset] !== "\x00") {
            $field = $body[$offset];
            $end = strpos($body, "\x00", $offset + 1);
            $value = $end === false ? '' : substr($body, $offset + 1, $end - $offset - 1);
            $offset = $end === false ? $len : $end + 1;
            if ($field === 'C') {
                $code = $value !== '' ? $value : $code;
            } elseif ($field === 'M') {
                $message = $value !== '' ? $value : $message;
            } elseif ($field === 'D') {
                $detail = $value;
            }
        }
        $full = 'SQLSTATE['.$code.']: '.$message.($detail !== '' ? ' ('.$detail.')' : '');

        return [$code, $full];
    }

    private function countFromTag(string $tag, int $selectedRows, bool $fromExec): int
    {
        if (str_starts_with($tag, 'SELECT')) {
            return $fromExec ? 0 : $selectedRows;
        }
        foreach (['INSERT', 'UPDATE', 'DELETE', 'MERGE'] as $prefix) {
            if (str_starts_with($tag, $prefix)) {
                $parts = explode(' ', $tag);

                return (int) end($parts);
            }
        }
        if (str_starts_with($tag, 'COPY')) {
            $parts = explode(' ', $tag);

            return (int) end($parts);
        }

        return 0;
    }

    /**
     * @return resource stream with decoded bytea contents (pdo_pgsql parity)
     */
    private function decodeBytea(string $value)
    {
        $stream = fopen('php://memory', 'r+');
        if (str_starts_with($value, '\x')) {
            fwrite($stream, (string) hex2bin(substr($value, 2)));
        } else {
            fwrite($stream, (string) stripcslashes($value));
        }
        rewind($stream);

        return $stream;
    }

    /**
     * @throws PgWireException
     */
    private function poison(string $reason): never
    {
        if (is_resource($this->socket)) {
            @fclose($this->socket);
        }
        $this->socket = null;
        $this->inTransaction = false;
        throw new PgWireException('08006', 'server closed the connection unexpectedly: '.$reason);
    }

    private function setError(string $code, string $message): void
    {
        $this->errCode = $code;
        $this->errInfo = [$code, $code, $message];
    }

    /**
     * @throws PgWireException
     */
    private function fail(string $message, string $code): bool
    {
        $this->setError($code, $message);
        if ($this->errmode === PDO::ERRMODE_EXCEPTION) {
            throw new PgWireException($code, $message);
        }
        if ($this->errmode === PDO::ERRMODE_WARNING) {
            trigger_error('PDO::'.$message, E_USER_WARNING);
        }

        return false;
    }
}
