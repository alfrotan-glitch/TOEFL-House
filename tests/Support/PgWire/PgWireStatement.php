<?php

declare(strict_types=1);

namespace Tests\Support\PgWire;

use PDO;
use PDOStatement;
use stdClass;

/**
 * PDOStatement-compatible statement over the PgWire extended protocol.
 *
 * Parameter typing mirrors pdo_pgsql (server-side inference from unknown-type
 * text params); result typing mirrors pdo_pgsql by column OID.
 */
class PgWireStatement extends PDOStatement
{
    private PgWirePdo $pdo;

    private string $originalSql;

    private string $rewrittenSql;

    /** @var array<int, array{name: string, oid: int}> */
    private array $fields = [];

    /** @var list<array<string, mixed>> typed assoc rows */
    private array $rows = [];

    private string $tag = '';

    private int $position = 0;

    private bool $executed = false;

    private bool $closed = false;

    private int $fetchMode;

    /** @var list<mixed> */
    private array $fetchModeArgs = [];

    /** @var array<int, mixed> 1-based bound values */
    private array $boundValues = [];

    /** @var array<int, mixed> 1-based bound references */
    private array $boundRefs = [];

    /** @var array<string|int, array{0: mixed, 1: int}> column bindings */
    private array $boundColumns = [];

    private ?string $errCode = '00000';

    private array $errInfo = ['00000', '', ''];

    protected function __construct()
    {
        // Instantiated via create()/fromResult().
    }

    public static function create(PgWirePdo $pdo, string $originalSql, string $rewrittenSql, array $options = []): static
    {
        $stmt = new static;
        $stmt->pdo = $pdo;
        $stmt->originalSql = $originalSql;
        $stmt->rewrittenSql = $rewrittenSql;
        $stmt->fetchMode = $pdo->defaultFetchMode();
        unset($options);

        return $stmt;
    }

    /**
     * @param  array<int, array{name: string, oid: int}>  $fields
     * @param  array<int, array<int, string|null>>  $rawRows
     */
    public static function fromResult(PgWirePdo $pdo, string $sql, array $fields, array $rawRows, string $tag): static
    {
        $stmt = new static;
        $stmt->pdo = $pdo;
        $stmt->originalSql = $sql;
        $stmt->rewrittenSql = $sql;
        $stmt->fetchMode = $pdo->defaultFetchMode();
        $stmt->storeResult($fields, $rawRows, $tag);

        return $stmt;
    }

    public function bindColumn(string|int $column, mixed &$var, int $type = PDO::PARAM_STR, int $maxLength = 0, mixed $driverOptions = null): bool
    {
        unset($maxLength, $driverOptions);
        $this->boundColumns[$column] = [&$var, $type];

        return true;
    }

    public function bindParam(string|int $param, mixed &$var, int $type = PDO::PARAM_STR, int $maxLength = 0, mixed $driverOptions = null): bool
    {
        unset($type, $maxLength, $driverOptions);
        $index = $this->paramIndex($param);
        $this->boundRefs[$index] = &$var;
        unset($this->boundValues[$index]);

        return true;
    }

    public function bindValue(string|int $param, mixed $value, int $type = PDO::PARAM_STR): bool
    {
        unset($type);
        $index = $this->paramIndex($param);
        $this->boundValues[$index] = $value;
        unset($this->boundRefs[$index]);

        return true;
    }

    public function closeCursor(): bool
    {
        $this->closed = true;

        return true;
    }

    public function columnCount(): int
    {
        return count($this->fields);
    }

    public function debugDumpParams(): ?bool
    {
        echo 'SQL: '.$this->originalSql."\n";
        echo 'Params: '.count($this->boundValues + $this->boundRefs)."\n";

        return true;
    }

    public function errorCode(): ?string
    {
        return $this->errCode;
    }

    public function errorInfo(): array
    {
        return $this->errInfo;
    }

    public function execute(?array $params = null): bool
    {
        $this->closed = false;
        try {
            $effective = $this->boundValues;
            foreach ($this->boundRefs as $index => $ref) {
                $effective[$index] = $ref;
            }
            if ($params !== null) {
                foreach ($params as $key => $value) {
                    if (is_string($key)) {
                        throw new PgWireException('HY093', 'Invalid parameter number: mixed named and positional parameters');
                    }
                    $effective[(int) $key + 1] = $value;
                }
            }
            ksort($effective);
            $encoded = [];
            foreach ($effective as $index => $value) {
                $encoded[] = $this->pdo->encodeParam($value);
                unset($index);
            }
            $result = $this->pdo->executeExtended($this->rewrittenSql, $encoded);
            $this->storeResult($result['fields'], $result['rows'], $result['tag']);
            $this->setError('00000', '');

            return true;
        } catch (PgWireException $e) {
            $this->setError($e->getCode(), $e->getMessage());

            return $this->fail($e);
        }
    }

    public function fetch(int $mode = 0, int $cursorOrientation = PDO::FETCH_ORI_NEXT, int $cursorOffset = 0): mixed
    {
        $mode = $mode === 0 ? $this->fetchMode : $mode;
        if (! $this->executed || $this->closed) {
            return false;
        }
        $index = match ($cursorOrientation) {
            PDO::FETCH_ORI_NEXT => $this->position,
            PDO::FETCH_ORI_ABS => $cursorOffset,
            PDO::FETCH_ORI_REL => $this->position + $cursorOffset,
            PDO::FETCH_ORI_FIRST => 0,
            PDO::FETCH_ORI_LAST => count($this->rows) - 1,
            default => $this->position,
        };
        if ($index < 0 || $index >= count($this->rows)) {
            return false;
        }
        $this->position = $index + 1;
        $row = $this->projectRow($this->rows[$index], $mode);
        $this->applyBoundColumns($this->rows[$index]);

        return $row;
    }

    public function fetchAll(int $mode = 0, mixed ...$args): array
    {
        $mode = $mode === 0 ? $this->fetchMode : $mode;
        if (! $this->executed || $this->closed) {
            return [];
        }
        $base = $mode & ~0xFFFF;
        if ($base === PDO::FETCH_GROUP || $base === PDO::FETCH_UNIQUE) {
            throw new PgWireException('HY000', 'fetch mode GROUP/UNIQUE is not supported by this driver');
        }
        if ($mode === PDO::FETCH_FUNC) {
            throw new PgWireException('HY000', 'fetch mode FUNC is not supported by this driver');
        }
        $out = [];
        if ($mode === PDO::FETCH_KEY_PAIR) {
            foreach ($this->rows as $row) {
                $values = array_values($row);
                $out[$values[0] ?? null] = $values[1] ?? null;
            }
            $this->position = count($this->rows);

            return $out;
        }
        if ($mode === PDO::FETCH_COLUMN) {
            $column = (int) ($args[0] ?? 0);
            foreach ($this->rows as $row) {
                $out[] = array_values($row)[$column] ?? null;
            }
            $this->position = count($this->rows);

            return $out;
        }
        if ($mode === PDO::FETCH_CLASS) {
            $class = (string) ($args[0] ?? stdClass::class);
            $ctorArgs = (array) ($args[1] ?? []);
            foreach ($this->rows as $row) {
                $object = new $class(...$ctorArgs);
                foreach ($row as $key => $value) {
                    $object->{$key} = $value;
                }
                $out[] = $object;
            }
            $this->position = count($this->rows);

            return $out;
        }
        if ($mode === PDO::FETCH_INTO) {
            $object = $args[0] ?? new stdClass;
            foreach ($this->rows as $row) {
                foreach ($row as $key => $value) {
                    $object->{$key} = $value;
                }
                $out[] = clone $object;
            }
            $this->position = count($this->rows);

            return $out;
        }
        foreach ($this->rows as $row) {
            $out[] = $this->projectRow($row, $mode);
        }
        $this->position = count($this->rows);

        return $out;
    }

    public function fetchColumn(int $column = 0): mixed
    {
        $row = $this->fetch(PDO::FETCH_NUM);
        if ($row === false) {
            return false;
        }

        return $row[$column] ?? null;
    }

    public function fetchObject(?string $class = 'stdClass', array $constructorArgs = []): object|false
    {
        $row = $this->fetch(PDO::FETCH_ASSOC);
        if ($row === false) {
            return false;
        }
        $object = new $class(...$constructorArgs);
        foreach ($row as $key => $value) {
            $object->{$key} = $value;
        }

        return $object;
    }

    public function getAttribute(int $name): mixed
    {
        unset($name);

        return null;
    }

    public function getColumnMeta(int $column): array|false
    {
        $field = $this->fields[$column] ?? null;
        if ($field === null) {
            return false;
        }

        return [
            'native_type' => $this->nativeTypeName($field['oid']),
            'pdo_type' => PDO::PARAM_STR,
            'flags' => [],
            'table' => '',
            'name' => $field['name'],
            'len' => -1,
            'precision' => 0,
        ];
    }

    public function nextRowset(): bool
    {
        return false;
    }

    public function rowCount(): int
    {
        if ($this->fields !== []) {
            return count($this->rows);
        }
        $parts = explode(' ', $this->tag);
        $command = $parts[0] ?? '';
        if (in_array($command, ['INSERT', 'UPDATE', 'DELETE', 'MERGE', 'COPY'], true)) {
            return (int) end($parts);
        }

        return 0;
    }

    public function setAttribute(int $attribute, mixed $value): bool
    {
        unset($attribute, $value);

        return true;
    }

    public function setFetchMode(int $mode, mixed ...$args): bool
    {
        $this->fetchMode = $mode;
        $this->fetchModeArgs = $args;

        return true;
    }

    // ------------------------------------------------------------------

    /**
     * @param  array<int, array{name: string, oid: int}>  $fields
     * @param  array<int, array<int, string|null>>  $rawRows
     */
    private function storeResult(array $fields, array $rawRows, string $tag): void
    {
        $this->fields = $fields;
        $this->tag = $tag;
        $fold = $this->pdo->caseFolding();
        $rows = [];
        foreach ($rawRows as $raw) {
            $assoc = [];
            foreach ($fields as $i => $field) {
                $name = $field['name'];
                if ($fold === PDO::CASE_LOWER) {
                    $name = strtolower($name);
                } elseif ($fold === PDO::CASE_UPPER) {
                    $name = strtoupper($name);
                }
                $assoc[$name] = $this->pdo->convertValue($raw[$i] ?? null, $field['oid']);
            }
            $rows[] = $assoc;
        }
        $this->rows = $rows;
        $this->position = 0;
        $this->executed = true;
        $this->closed = false;
    }

    private function projectRow(array $assoc, int $mode): mixed
    {
        $base = $mode & 0xFFFF;

        return match ($base) {
            PDO::FETCH_ASSOC, PDO::FETCH_NAMED => $assoc,
            PDO::FETCH_NUM => array_values($assoc),
            PDO::FETCH_BOTH => $this->bothRow($assoc),
            PDO::FETCH_OBJ, PDO::FETCH_LAZY => (object) $assoc,
            PDO::FETCH_COLUMN => array_values($assoc)[(int) ($this->fetchModeArgs[0] ?? 0)] ?? null,
            PDO::FETCH_CLASS => $this->intoNew((string) ($this->fetchModeArgs[0] ?? stdClass::class), (array) ($this->fetchModeArgs[1] ?? []), $assoc),
            PDO::FETCH_INTO => $this->intoExisting($this->fetchModeArgs[0] ?? new stdClass, $assoc),
            PDO::FETCH_BOUND => $assoc,
            default => throw new PgWireException('HY000', 'fetch mode '.$mode.' is not supported by this driver'),
        };
    }

    private function bothRow(array $assoc): array
    {
        $row = [];
        $i = 0;
        foreach ($assoc as $key => $value) {
            $row[$i] = $value;
            $row[$key] = $value;
            $i++;
        }

        return $row;
    }

    private function intoNew(string $class, array $ctorArgs, array $assoc): object
    {
        $object = new $class(...$ctorArgs);
        foreach ($assoc as $key => $value) {
            $object->{$key} = $value;
        }

        return $object;
    }

    private function intoExisting(mixed $object, array $assoc): object
    {
        $target = is_object($object) ? $object : new stdClass;
        foreach ($assoc as $key => $value) {
            $target->{$key} = $value;
        }

        return $target;
    }

    /** @param array<string, mixed> $assoc */
    private function applyBoundColumns(array $assoc): void
    {
        if ($this->boundColumns === []) {
            return;
        }
        $values = array_values($assoc);
        foreach ($this->boundColumns as $column => &$binding) {
            $type = $binding[1];
            $value = is_int($column) ? ($values[$column] ?? null) : ($assoc[$column] ?? null);
            if ($value !== null) {
                $value = match ($type) {
                    PDO::PARAM_INT => (int) $value,
                    PDO::PARAM_BOOL => (bool) $value,
                    default => (string) $value,
                };
            }
            // Element 0 aliases the caller's variable (stored by reference).
            $binding[0] = $value;
        }
        unset($binding);
    }

    private function paramIndex(string|int $param): int
    {
        if (is_string($param)) {
            throw new PgWireException('HY093', 'Invalid parameter number: named parameters are not supported by the pgsql driver');
        }
        if ($param < 1) {
            throw new PgWireException('HY093', 'Invalid parameter number: positional parameters are 1-based');
        }

        return $param;
    }

    private function nativeTypeName(int $oid): string
    {
        return match ($oid) {
            16 => 'bool',
            17 => 'bytea',
            20 => 'int8',
            21 => 'int2',
            23 => 'int4',
            25 => 'text',
            700 => 'float4',
            701 => 'float8',
            1043 => 'varchar',
            1700 => 'numeric',
            1082 => 'date',
            1114 => 'timestamp',
            1184 => 'timestamptz',
            2950 => 'uuid',
            114 => 'json',
            3802 => 'jsonb',
            default => 'unknown',
        };
    }

    private function setError(string $code, string $message): void
    {
        $this->errCode = $code;
        $this->errInfo = [$code, $code, $message];
    }

    private function fail(PgWireException $e): bool
    {
        if ($this->pdo->getAttribute(PDO::ATTR_ERRMODE) === PDO::ERRMODE_EXCEPTION) {
            throw $e;
        }
        if ($this->pdo->getAttribute(PDO::ATTR_ERRMODE) === PDO::ERRMODE_WARNING) {
            trigger_error($e->getMessage(), E_USER_WARNING);
        }

        return false;
    }
}
