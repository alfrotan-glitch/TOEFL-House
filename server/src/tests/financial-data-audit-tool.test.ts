/**
 * The read-only financial data audit tool must be trustworthy.
 * ============================================================================
 * `scripts/audit-financial-data.mjs` is the only evidence a deploying operator
 * will have about whether their EXISTING database already contains corrupt
 * monetary values. Entry-point validation and migration 069 stop new ones, but
 * neither rewrites history — deliberately, because silently "correcting" a
 * financial record destroys the evidence of what happened.
 *
 * That makes the tool itself release-critical, so its contract is pinned here:
 *
 *   exit 0  database read successfully, nothing corrupt found
 *   exit 1  corrupt values found — a human must decide on each
 *   exit 2  could NOT read the database at all
 *
 * The exit-2 case matters most. The first version let better-sqlite3 throw a
 * raw stack trace while the process still exited 0, so a deploy gate reading
 * the exit code would have read "I could not look at all" as "I looked and it
 * was clean" — the worst possible failure for a safety check.
 *
 * It must also never write: these tests assert the file is byte-identical
 * before and after a run.
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
const script = path.join(serverRoot, 'scripts', 'audit-financial-data.mjs');
const schemaSql = fs.readFileSync(path.join(serverRoot, 'src', 'db', 'schema.sql'), 'utf8');

/** Run the tool and capture both its exit code and its output. */
function runAudit(dbFile: string): { code: number; out: string } {
  try {
    const out = execFileSync('node', [script, dbFile], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    return { code: 0, out };
  } catch (err) {
    const e = err as { status?: number; stdout?: string; stderr?: string };
    return { code: e.status ?? -1, out: `${e.stdout ?? ''}${e.stderr ?? ''}` };
  }
}

function newDbFile(name: string): string {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'audit-tool-')), name);
}

/** A database built from the real schema, so column names are not guessed. */
function buildDb(file: string): Database.Database {
  const db = new Database(file);
  db.exec(schemaSql);
  return db;
}

let cleanDb: string;
let corruptDb: string;

beforeAll(() => {
  cleanDb = newDbFile('clean.sqlite');
  buildDb(cleanDb).close();

  corruptDb = newDbFile('corrupt.sqlite');
  const db = buildDb(corruptDb);
  // Insert the exact shapes that reached production-shaped databases before
  // the entry points were validated.
  db.prepare("INSERT INTO branches (id, name, code, is_active) VALUES ('b1','B','B-1',1)").run();
  // This fixture models a damaged historical file: the current database trigger
  // is removed only in this disposable copy so the audit can prove it detects
  // records that a current writer would refuse.
  db.exec('DROP TRIGGER IF EXISTS trg_books_money_insert');
  db.prepare("INSERT INTO books (id, title, item_kind, sale_enabled, sale_price, lending_enabled, status, branch_id) VALUES ('bk_bad','Bad','book',1,'abc',0,'active','b1')").run();
  db.prepare("INSERT INTO books (id, title, item_kind, sale_enabled, sale_price, lending_enabled, status, branch_id) VALUES ('bk_neg','Neg','book',1,-100,0,'active','b1')").run();
  db.prepare("INSERT INTO books (id, title, item_kind, sale_enabled, sale_price, lending_enabled, status, branch_id) VALUES ('bk_big','Big','book',1,1e15,0,'active','b1')").run();
  db.close();
});

/**
 * Timeout note: this suite builds a real database (schema + all 75 migrations)
 * and/or spawns a child process. On an unloaded 2-CPU runner that is fast, but
 * under CPU contention the same work was measured ~5x slower, which brings it
 * close to the global 10 s testTimeout on a busy CI machine. The generous suite
 * timeout below removes that environment-sensitivity; no assertion is relaxed.
 */
describe('financial data audit tool', { timeout: 60_000 }, () => {
  it('exits 0 and reports clean on a database with no corrupt money', () => {
    const { code, out } = runAudit(cleanDb);
    expect(code).toBe(0);
    expect(out).toContain('clean');
  });

  it('exits 1 and names the corrupt rows', () => {
    const { code, out } = runAudit(corruptDb);
    expect(code).toBe(1);
    expect(out).toContain('books.sale_price');
    // The specific record ids must be present so a human can go look at them.
    expect(out).toContain('bk_bad');
    expect(out).toContain('bk_neg');
    expect(out).toContain('bk_big');
  });

  it('classifies each corruption type it finds', () => {
    const { out } = runAudit(corruptDb);
    expect(out).toContain('non-numeric value stored');
    expect(out).toContain('negative amount');
    expect(out).toContain('exceeds supported monetary precision');
  });

  it('states the blast radius and whether the row is safe to leave', () => {
    const { out } = runAudit(corruptDb);
    expect(out).toContain('blast radius');
    expect(out).toContain('safe to leave');
    // books.sale_price is cash-affecting, so it must NOT be marked safe to leave.
    expect(out).toMatch(/books\.sale_price[\s\S]*?safe to leave: NO/);
  });

  it('exits 2 when the database does not exist, rather than passing silently', () => {
    // The dangerous failure: "could not look" must never look like "clean".
    const { code, out } = runAudit(path.join(os.tmpdir(), 'definitely-not-here.sqlite'));
    expect(code).toBe(2);
    expect(out).toContain('not found');
  });

  it('exits 2 when the file is not a database', () => {
    const notDb = newDbFile('notadb.sqlite');
    fs.writeFileSync(notDb, 'this is not a sqlite file');
    expect(runAudit(notDb).code).toBe(2);
  });

  it('never modifies the database it audits', () => {
    const digest = (f: string) => crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex');
    const before = digest(corruptDb);
    runAudit(corruptDb);
    // Byte-identical: the tool opens readonly and must stay that way.
    expect(digest(corruptDb)).toBe(before);
  });
});
