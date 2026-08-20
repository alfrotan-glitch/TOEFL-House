/**
 * Canonical schema preflight.
 *
 * `src/db/schema.sql` is the single authority for the database shape (§12).
 * This script proves the four properties the rest of the system depends on:
 *
 *   1. STANDS ALONE   — an empty database plus schema.sql is a complete,
 *                       structurally valid database. No other artifact runs.
 *   2. SOUND          — integrity_check and foreign_key_check both pass, and
 *                       every index refers to a column that really exists.
 *                       (An index over a column added by an ALTER that no
 *                       longer runs is the classic way this file used to rot.)
 *   3. IDEMPOTENT     — applying the schema to an already-initialized database
 *                       is a no-op. Startup applies it on every boot, so a
 *                       statement without IF NOT EXISTS would crash the second
 *                       start of every installation.
 *   4. SOLE AUTHORITY — no migration chain has reappeared. Two mechanisms that
 *                       can both change the schema is duplicate authority
 *                       (LAW 1), which this repository does not permit.
 */
import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const serverRoot = path.resolve(__dirname, '..');
const schemaPath = path.join(serverRoot, 'src', 'db', 'schema.sql');

const shapeOf = (db) => {
  const out = {};
  const tables = db
    .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
    .all();
  for (const { name } of tables) {
    out[name] = db
      .prepare(`PRAGMA table_info(${JSON.stringify(name)})`)
      .all()
      .map((c) => `${c.name}:${c.type}:${c.notnull}:${c.dflt_value ?? ''}:${c.pk}`);
  }
  return out;
};

const countOf = (db, type) =>
  db.prepare("SELECT COUNT(*) c FROM sqlite_master WHERE type=? AND name NOT LIKE 'sqlite_%'").get(type).c;

const schemaSql = fs.readFileSync(schemaPath, 'utf8');
const db = new Database(':memory:');

try {
  // ── 1. schema.sql must stand on its own ──────────────────────────────────
  db.pragma('foreign_keys = OFF');
  db.exec(schemaSql);
  db.pragma('foreign_keys = ON');

  const tables = countOf(db, 'table');
  const indexes = countOf(db, 'index');
  const triggers = countOf(db, 'trigger');
  if (tables === 0) throw new Error('schema.sql created no tables');

  // ── 2. the result must be sound ──────────────────────────────────────────
  const badIndexes = [];
  for (const index of db
    .prepare("SELECT name, tbl_name FROM sqlite_master WHERE type='index' AND sql IS NOT NULL")
    .all()) {
    const tableColumns = new Set(
      db.prepare(`PRAGMA table_info(${JSON.stringify(index.tbl_name)})`).all().map((r) => r.name)
    );
    for (const column of db.prepare(`PRAGMA index_info(${JSON.stringify(index.name)})`).all()) {
      if (column.name !== null && !tableColumns.has(column.name)) {
        badIndexes.push(`${index.tbl_name}.${column.name} via ${index.name}`);
      }
    }
  }
  if (badIndexes.length) throw new Error(`indexes over columns that do not exist: ${badIndexes.join(', ')}`);

  const integrity = db.pragma('integrity_check', { simple: true });
  if (integrity !== 'ok') throw new Error(`integrity_check = ${integrity}`);

  const fkViolations = db.pragma('foreign_key_check');
  if (fkViolations.length) throw new Error(`${fkViolations.length} foreign-key violation(s)`);

  // ── 3. re-applying the schema must change nothing ────────────────────────
  const before = JSON.stringify(shapeOf(db));
  db.pragma('foreign_keys = OFF');
  db.exec(schemaSql);
  db.pragma('foreign_keys = ON');
  const after = JSON.stringify(shapeOf(db));
  if (before !== after) {
    throw new Error('schema.sql is not idempotent — a second application changed the database shape');
  }
  if (countOf(db, 'table') !== tables) throw new Error('re-applying schema.sql changed the table count');

  // ── 4. the schema must remain the only authority ─────────────────────────
  const rogue = [
    path.join(serverRoot, 'src', 'db', 'migrations'),
    path.join(serverRoot, 'src', 'db', 'migrate.ts'),
  ].filter((p) => fs.existsSync(p));
  if (rogue.length) {
    throw new Error(
      `a second schema authority has reappeared: ${rogue.join(', ')}. ` +
        'The canonical schema is src/db/schema.sql and nothing else may alter the shape.'
    );
  }
  if (db.prepare("SELECT COUNT(*) c FROM sqlite_master WHERE name='schema_migrations'").get().c > 0) {
    throw new Error('schema.sql declares a schema_migrations table; there is no migration chain');
  }

  console.log(
    `[SUCCESS] Canonical schema preflight passed ` +
      `(${tables} tables, ${indexes} indexes, ${triggers} triggers; stands alone, sound, idempotent, sole authority).`
  );
} finally {
  db.close();
}
