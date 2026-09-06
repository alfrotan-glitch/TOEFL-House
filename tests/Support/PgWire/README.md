# PgWire — test-only PostgreSQL driver for extension-less PHP builds

Some sandboxed PHP builds are statically linked and cannot load `pdo_pgsql`.
This directory provides a pure-PHP PostgreSQL v3 wire-protocol driver that
implements the exact PDO surface Illuminate needs, so the suite runs
unmodified in such environments.

- `PgWirePdo` — `PDO` subclass: connection, simple + extended protocols,
  `?` → `$n` placeholder rewriting (including the `??` escape), transactions,
  quoting. Parameter semantics match `pdo_pgsql` (server-side inference from
  unknown-type text binds); result typing matches by column OID.
- `PgWireStatement` — `PDOStatement` subclass: binds, fetch modes, row counts.
- `PgWireException` — `PDOException` carrying the SQLSTATE.
- `bootstrap.php` — registers an Illuminate `pgsql` connection resolver that
  builds `PgWirePdo`; loaded by `tests/bootstrap.php` ONLY when
  `extension_loaded('pdo_pgsql')` is false.

When the native driver is available, none of this code loads and behavior is
byte-for-byte the standard Laravel + pgsql path. Not for production use.
