/**
 * Schema/migration parity — every index declared in schema.sql must actually
 * exist after the full migration chain runs.
 * ============================================================================
 * DEFECT CLASS THIS PROTECTS AGAINST
 *
 * SQLite cannot ALTER most constraints, so migrations rebuild tables with
 * CREATE-new / INSERT-select / DROP-old / RENAME. Dropping a table silently
 * drops its indexes, and a rebuild that forgets to recreate one leaves no
 * error behind — the migration succeeds, the app boots, queries still return
 * correct answers, and the only symptom is a different query plan.
 *
 * That produced real drift here: `idx_users_role` (dropped by the 052 users
 * rebuild) and `idx_placement_profile_program_branch` (dropped by the 058
 * placement rebuild) were declared in schema.sql but absent from a freshly
 * built database, so `SELECT * FROM users WHERE role = ?` did a full SCAN on
 * new installs while older databases used the index. Migration 068 restores
 * them.
 *
 * This test asserts the invariant for ALL indexes rather than the two known
 * ones, so the next forgotten rebuild fails here instead of in production.
 */
import { describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runMigrations } from '../db/migrate.js';

const dbDir = path.resolve(fileURLToPath(new URL('.', import.meta.url)), '..', 'db');

/** Build a database exactly the way a brand-new install does: schema then migrations. */
function buildFreshDatabase(): Database.Database {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'parity-')), 'fresh.sqlite');
  const db = new Database(file);
  db.exec(fs.readFileSync(path.join(dbDir, 'schema.sql'), 'utf8'));
  runMigrations(db);
  return db;
}

function declaredIndexNames(): Set<string> {
  const sql = fs.readFileSync(path.join(dbDir, 'schema.sql'), 'utf8');
  const names = new Set<string>();
  const re = /CREATE\s+(?:UNIQUE\s+)?INDEX\s+(?:IF\s+NOT\s+EXISTS\s+)?([A-Za-z0-9_]+)/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(sql)) !== null) names.add(m[1]);
  return names;
}

describe('schema.sql and the migration chain agree', () => {
  it('every index declared in schema.sql survives the full migration chain', () => {
    const db = buildFreshDatabase();
    const actual = new Set(
      (db.prepare("SELECT name FROM sqlite_master WHERE type='index' AND name NOT LIKE 'sqlite_%'")
        .all() as Array<{ name: string }>).map((r) => r.name),
    );

    const missing = [...declaredIndexNames()].filter((n) => !actual.has(n)).sort();
    // A non-empty list means some migration rebuilt a table and forgot to
    // recreate an index it inherited.
    expect(missing).toEqual([]);
    db.close();
  });

  it('the two indexes lost in the 052 and 058 rebuilds are present', () => {
    const db = buildFreshDatabase();
    const has = (n: string) =>
      (db.prepare("SELECT COUNT(*) c FROM sqlite_master WHERE type='index' AND name = ?").get(n) as { c: number }).c === 1;

    expect(has('idx_users_role')).toBe(true);
    expect(has('idx_placement_profile_program_branch')).toBe(true);
    db.close();
  });

  it('users-by-role uses an index rather than scanning the table', () => {
    // The user-visible consequence of the drift: identical code, identical
    // reported schema version, different execution plan.
    const db = buildFreshDatabase();
    const plan = db.prepare('EXPLAIN QUERY PLAN SELECT * FROM users WHERE role = ?').all('owner') as Array<{ detail: string }>;
    expect(plan.map((r) => r.detail).join(' ')).toContain('idx_users_role');
    db.close();
  });

  it('runs the whole chain without foreign-key violations', () => {
    const db = buildFreshDatabase();
    db.pragma('foreign_keys = ON');
    expect(db.pragma('foreign_key_check')).toEqual([]);
    expect((db.pragma('integrity_check') as Array<{ integrity_check: string }>)[0].integrity_check).toBe('ok');
    db.close();
  });
});
