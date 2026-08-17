/**
 * The post-deployment verifier must actually catch a bad deployment.
 * ============================================================================
 * `scripts/verify-deployment.mjs` is how an operator closes release item H-4
 * (and confirms 067/069 landed) against the REAL database after deploying.
 * A verifier that only ever says PASS is worse than no verifier, so these
 * tests sabotage a good database in each of the specific ways a deployment can
 * go wrong and assert that each one is reported.
 *
 * Contract:
 *   exit 0  every check passed
 *   exit 1  at least one check failed
 *   exit 2  could not read the database
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import Database from 'better-sqlite3';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runMigrations } from '../db/migrate.js';

const serverRoot = path.resolve(fileURLToPath(new URL('.', import.meta.url)), '..', '..');
const script = path.join(serverRoot, 'scripts', 'verify-deployment.mjs');
const schemaSql = fs.readFileSync(path.join(serverRoot, 'src', 'db', 'schema.sql'), 'utf8');

function run(dbFile: string): { code: number; out: string } {
  try {
    const out = execFileSync('node', [script, dbFile], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    return { code: 0, out };
  } catch (err) {
    const e = err as { status?: number; stdout?: string; stderr?: string };
    return { code: e.status ?? -1, out: `${e.stdout ?? ''}${e.stderr ?? ''}` };
  }
}

/** A fully deployed database: schema + every migration + a backup snapshot. */
function buildDeployed(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'deployed-'));
  const file = path.join(dir, 'erp.sqlite');
  const db = new Database(file);
  db.exec(schemaSql);
  runMigrations(db);
  db.close();
  // runMigrations skips its snapshot under NODE_ENV=test, so create the
  // artefact the verifier looks for.
  fs.mkdirSync(path.join(dir, 'backups'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'backups', 'pre-migration-2026-01-01T00-00-00-000Z.sqlite'), '');
  return file;
}

/** Copy a deployed database, then break it in one specific way. */
function sabotage(mutate: (db: Database.Database) => void): string {
  const src = buildDeployed();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sabotage-'));
  const file = path.join(dir, 'erp.sqlite');
  fs.copyFileSync(src, file);
  fs.mkdirSync(path.join(dir, 'backups'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'backups', 'pre-migration-2026-01-01T00-00-00-000Z.sqlite'), '');
  const db = new Database(file);
  mutate(db);
  db.close();
  return file;
}

let deployed: string;
beforeAll(() => { deployed = buildDeployed(); });

describe('deployment verifier', () => {
  it('passes on a correctly deployed database', () => {
    const { code, out } = run(deployed);
    expect(out).toContain('0 failed');
    expect(code).toBe(0);
  });

  it('reports H-4 explicitly so the operator can close it', () => {
    expect(run(deployed).out).toContain('H-4: migration 068 indexes present');
  });

  it('FAILS when a migration 068 index is missing', () => {
    const file = sabotage((db) => db.exec('DROP INDEX IF EXISTS idx_users_role'));
    const { code, out } = run(file);
    expect(code).toBe(1);
    expect(out).toMatch(/FAIL {2}H-4/);
    expect(out).toContain('idx_users_role');
  });

  it('FAILS when a migration 069 money guard is missing', () => {
    const file = sabotage((db) => db.exec('DROP TRIGGER IF EXISTS trg_invoices_nonnegative_insert'));
    const { code, out } = run(file);
    expect(code).toBe(1);
    expect(out).toContain('trg_invoices_nonnegative_insert');
  });

  it('FAILS when a branch does not reconcile to its ledger', () => {
    const file = sabotage((db) => {
      db.prepare("INSERT OR IGNORE INTO branches (id, name, code, is_active) VALUES ('1','Main','M-1',1)").run();
      db.prepare(`INSERT OR REPLACE INTO finance_accounts (scope_type, scope_id, main_balance, saving_balance)
                  VALUES ('branch','1',99999,0)`).run();
    });
    const { code, out } = run(file);
    expect(code).toBe(1);
    expect(out).toContain('reconciles to its ledger');
    expect(out).toContain('99999');
  });

  it('FAILS when a migration on disk was never applied', () => {
    const file = sabotage((db) => db.prepare("DELETE FROM schema_migrations WHERE version LIKE '069%'").run());
    const { code, out } = run(file);
    expect(code).toBe(1);
    expect(out).toContain('NOT applied');
  });

  it('FAILS when no pre-migration backup exists', () => {
    const src = buildDeployed();
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nobackup-'));
    const file = path.join(dir, 'erp.sqlite');
    fs.copyFileSync(src, file); // deliberately no backups/ directory
    const { code, out } = run(file);
    expect(code).toBe(1);
    expect(out).toContain('backup');
  });

  it('exits 2 when the database cannot be read', () => {
    expect(run(path.join(os.tmpdir(), 'nope-not-here.sqlite')).code).toBe(2);
  });

  it('never modifies the database it verifies', () => {
    const digest = (f: string) => crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex');
    const before = digest(deployed);
    run(deployed);
    expect(digest(deployed)).toBe(before);
  });
});
