/**
 * Fresh-schema preflight.
 *
 * Two guarantees:
 *   1. schema.sql alone builds a structurally valid database.
 *   2. schema.sql does NOT drift from the real, fully-migrated schema.
 *
 * (2) matters because schema.sql is what a brand-new installation gets before
 * migrations run, and several routes are prepared at import time. A column
 * that exists only after a migration is invisible to the old preflight, yet
 * `SELECT idempotency_key …` against a schema.sql-only database throws.
 * Comparing both shapes is the only way to catch that class of bug.
 */
import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const serverRoot = path.resolve(__dirname, '..');
const schemaPath = path.join(serverRoot, 'src', 'db', 'schema.sql');
const migrationsDir = path.join(serverRoot, 'src', 'db', 'migrations');

/** Tables created exclusively by migrations; they legitimately have no
 *  definition in schema.sql and are created on every install by the runner. */
const MIGRATION_ONLY_TABLES = new Set([
  'schema_migrations',
  'teacher_branch_history',
  'teacher_compensation_history',
]);

function columnsOf(db, table) {
  return new Set(db.prepare(`PRAGMA table_info(${JSON.stringify(table)})`).all().map((r) => r.name));
}

function tablesOf(db) {
  return db
    .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'")
    .all()
    .map((r) => r.name);
}

/** Applies a migration file the same way the runtime runner does: one
 *  statement at a time, tolerating already-satisfied ALTERs. */
function applyMigration(db, sql) {
  const withoutBlockComments = sql.replace(/\/\*[\s\S]*?\*\//g, '');
  const lines = withoutBlockComments.split(/\r?\n/);
  let statement = '';
  let inString = false;
  let stringChar = '';
  let inTrigger = false;
  const statements = [];
  for (const line of lines) {
    const trimmed = line.trim();
    if (!inString && (trimmed.startsWith('--') || trimmed === '')) continue;
    if (/CREATE\s+(OR\s+REPLACE\s+)?TRIGGER/i.test(trimmed)) inTrigger = true;
    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      if (inString) {
        statement += ch;
        if (ch === stringChar) inString = false;
        continue;
      }
      if (ch === "'" || ch === '"') { inString = true; stringChar = ch; statement += ch; continue; }
      if (ch === '-' && line[i + 1] === '-') break;
      if (ch === ';' && !inTrigger) { statements.push(statement); statement = ''; continue; }
      statement += ch;
    }
    statement += '\n';
    if (inTrigger && /^\s*END\s*;?\s*$/i.test(trimmed)) { statements.push(statement); statement = ''; inTrigger = false; }
  }
  if (statement.trim()) statements.push(statement);

  for (const raw of statements) {
    const stmt = raw.trim();
    if (!stmt || /^(BEGIN|COMMIT|END|ROLLBACK)(\s+TRANSACTION)?$/i.test(stmt)) continue;
    try {
      db.exec(stmt);
    } catch (err) {
      const msg = String(err.message || '');
      // Idempotent re-application is expected for ADD COLUMN / duplicate index.
      if (/duplicate column name|already exists/i.test(msg)) continue;
      throw new Error(`${msg}\n  in statement: ${stmt.slice(0, 160)}`, { cause: err });
    }
  }
}

const fresh = new Database(':memory:');
const migrated = new Database(':memory:');
try {
  const schemaSql = fs.readFileSync(schemaPath, 'utf8');

  // ── 1. schema.sql must stand on its own ──────────────────────────────────
  fresh.pragma('foreign_keys = ON');
  fresh.exec(schemaSql);

  const badIndexes = [];
  const indexes = fresh.prepare("SELECT name, tbl_name FROM sqlite_master WHERE type='index' AND sql IS NOT NULL").all();
  for (const index of indexes) {
    const indexColumns = fresh.prepare(`PRAGMA index_info(${JSON.stringify(index.name)})`).all().map((row) => row.name);
    const tableColumns = columnsOf(fresh, index.tbl_name);
    for (const column of indexColumns) {
      if (!tableColumns.has(column)) badIndexes.push(`${index.tbl_name}.${column} via ${index.name}`);
    }
  }
  if (badIndexes.length) throw new Error(`Invalid schema indexes: ${badIndexes.join(', ')}`);
  fresh.pragma('integrity_check');

  // ── 2. schema.sql must match the fully-migrated shape ────────────────────
  migrated.pragma('foreign_keys = OFF');
  migrated.exec(schemaSql);
  const files = fs.readdirSync(migrationsDir).filter((f) => f.endsWith('.sql')).sort();
  for (const file of files) {
    applyMigration(migrated, fs.readFileSync(path.join(migrationsDir, file), 'utf8'));
  }

  const drift = [];
  for (const table of tablesOf(migrated)) {
    if (MIGRATION_ONLY_TABLES.has(table)) continue;
    const freshCols = columnsOf(fresh, table);
    if (!freshCols.size) { drift.push(`table "${table}" is missing from schema.sql`); continue; }
    for (const col of columnsOf(migrated, table)) {
      if (!freshCols.has(col)) drift.push(`${table}.${col} exists only after migrations`);
    }
  }

  if (drift.length) {
    throw new Error(
      `schema.sql has drifted from the migrated schema — a fresh install would be missing these:\n  - ${drift.join('\n  - ')}`
    );
  }

  console.log(`[SUCCESS] Fresh schema preflight passed (${files.length} migrations, no drift).`);
} finally {
  fresh.close();
  migrated.close();
}
