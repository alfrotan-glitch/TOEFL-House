/**
 * The post-deployment verifier must actually catch a bad deployment.
 * ============================================================================
 * `scripts/verify-deployment.mjs` is how an operator confirms that the
 * database they just deployed onto really matches the canonical schema. A
 * verifier that only ever says PASS is worse than no verifier, so these tests
 * sabotage a good database in each specific way a deployment can go wrong and
 * assert that each one is reported.
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

/** A correctly deployed database: the canonical schema, nothing else. */
function buildDeployed(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'deployed-'));
  const file = path.join(dir, 'erp.sqlite');
  const db = new Database(file);
  db.exec(schemaSql);
  db.close();
  return file;
}

/** Copy a deployed database, then break it in one specific way. */
function sabotage(mutate: (db: Database.Database) => void): string {
  const src = buildDeployed();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sabotage-'));
  const file = path.join(dir, 'erp.sqlite');
  fs.copyFileSync(src, file);
  const db = new Database(file);
  mutate(db);
  db.close();
  return file;
}

let deployed: string;
beforeAll(() => { deployed = buildDeployed(); });

/**
 * Timeout note: every case here builds a REAL database and then spawns
 * `node scripts/verify-deployment.mjs` as a child process. Under CPU
 * contention on a small runner the build and the subprocess compete for the
 * same cores, and cases measured at ~0.55 s unloaded have been observed at
 * ~2.8 s. The generous suite timeout removes that environment-sensitivity
 * without weakening a single assertion.
 */
describe('deployment verifier', { timeout: 60_000 }, () => {
  it('passes on a correctly deployed database', () => {
    const { code, out } = run(deployed);
    expect(out).toContain('0 failed');
    expect(code).toBe(0);
  });

  it('FAILS when a canonical table is missing', () => {
    const file = sabotage((db) => db.exec('DROP TABLE IF EXISTS notifications'));
    const { code, out } = run(file);
    expect(code).toBe(1);
    expect(out).toContain('notifications');
  });

  it('FAILS when a canonical index is missing', () => {
    const file = sabotage((db) => db.exec('DROP INDEX IF EXISTS idx_users_branch'));
    const { code, out } = run(file);
    expect(code).toBe(1);
    expect(out).toContain('idx_users_branch');
  });

  it('FAILS when a financial integrity trigger is missing', () => {
    const file = sabotage((db) => db.exec('DROP TRIGGER IF EXISTS trg_invoices_nonnegative_insert'));
    const { code, out } = run(file);
    expect(code).toBe(1);
    expect(out).toContain('trg_invoices_nonnegative_insert');
  });

  it('FAILS when a canonical column is missing from a table', () => {
    // A column cannot be dropped from under a live index, so the whole table
    // is rebuilt one column short — exactly what a half-finished hand edit to
    // a deployed database looks like.
    const file = sabotage((db) => {
      db.exec('PRAGMA foreign_keys = OFF');
      db.exec('DROP TABLE IF EXISTS success_stories');
      db.exec('CREATE TABLE success_stories (id TEXT PRIMARY KEY)');
    });
    const { code, out } = run(file);
    expect(code).toBe(1);
    expect(out).toContain('success_stories.');
  });

  it('FAILS when the database carries a table the canonical schema does not declare', () => {
    const file = sabotage((db) => db.exec('CREATE TABLE leftover_scratch (id TEXT PRIMARY KEY)'));
    const { code, out } = run(file);
    expect(code).toBe(1);
    expect(out).toContain('leftover_scratch');
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
