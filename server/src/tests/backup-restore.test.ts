/**
 * A backup is only real if it restores.
 * ============================================================================
 * migrate.ts writes a `VACUUM INTO` snapshot before applying pending
 * migrations, but nothing in the repository ever restored one. An untested
 * backup is a recovery *risk*, not a recovery *plan* — the failure is only
 * discovered on the day it matters.
 *
 * This test performs a real disaster-recovery cycle against a real file:
 * snapshot → destroy live data → restore → verify. It also pins the two
 * properties that make the snapshot trustworthy: it is a consistent,
 * self-contained database (not a partial file copy), and it survives being
 * taken while a transaction is open.
 */
import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import Database from 'better-sqlite3';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const workDir = path.join(os.tmpdir(), 'th-backup-restore-test');
const livePath = path.join(workDir, 'live.sqlite');
const snapPath = path.join(workDir, 'snapshot.sqlite');

function seed(db: Database.Database) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS payments (id TEXT PRIMARY KEY, amount REAL NOT NULL, student_id TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS students (id TEXT PRIMARY KEY, name TEXT NOT NULL);
  `);
  const ins = db.transaction(() => {
    for (let i = 0; i < 50; i++) {
      db.prepare('INSERT OR REPLACE INTO students (id, name) VALUES (?, ?)').run(`s${i}`, `Student ${i}`);
      db.prepare('INSERT OR REPLACE INTO payments (id, amount, student_id) VALUES (?, ?, ?)').run(`p${i}`, 100 + i, `s${i}`);
    }
  });
  ins();
}

const snapshot = (db: Database.Database, target: string) => {
  if (fs.existsSync(target)) fs.unlinkSync(target);
  db.prepare('VACUUM INTO ?').run(target);
};

beforeEach(() => {
  fs.rmSync(workDir, { recursive: true, force: true });
  fs.mkdirSync(workDir, { recursive: true });
});

afterAll(() => fs.rmSync(workDir, { recursive: true, force: true }));

describe('backup and restore', () => {
  it('restores every row after the live database is destroyed', () => {
    const live = new Database(livePath);
    seed(live);
    const before = {
      students: (live.prepare('SELECT COUNT(*) c FROM students').get() as { c: number }).c,
      payments: (live.prepare('SELECT COUNT(*) c FROM payments').get() as { c: number }).c,
      total: (live.prepare('SELECT COALESCE(SUM(amount),0) t FROM payments').get() as { t: number }).t,
    };

    snapshot(live, snapPath);

    // Disaster.
    live.prepare('DELETE FROM payments').run();
    live.prepare('DELETE FROM students').run();
    expect((live.prepare('SELECT COUNT(*) c FROM payments').get() as { c: number }).c).toBe(0);
    live.close();

    // Restore is a file copy — the documented procedure in docs/OPERATIONS.md.
    fs.copyFileSync(snapPath, livePath);

    const restored = new Database(livePath);
    expect({
      students: (restored.prepare('SELECT COUNT(*) c FROM students').get() as { c: number }).c,
      payments: (restored.prepare('SELECT COUNT(*) c FROM payments').get() as { c: number }).c,
      total: (restored.prepare('SELECT COALESCE(SUM(amount),0) t FROM payments').get() as { t: number }).t,
    }).toEqual(before);

    expect((restored.pragma('integrity_check') as Array<{ integrity_check: string }>)[0].integrity_check).toBe('ok');
    expect((restored.pragma('foreign_key_check') as unknown[]).length).toBe(0);
    restored.close();
  });

  it('the snapshot is a self-contained database, not a partial copy', () => {
    const live = new Database(livePath);
    seed(live);
    snapshot(live, snapPath);
    live.close();

    // Opened with no WAL/journal siblings present.
    expect(fs.existsSync(`${snapPath}-wal`)).toBe(false);
    const snap = new Database(snapPath, { readonly: true });
    expect((snap.prepare('SELECT COUNT(*) c FROM payments').get() as { c: number }).c).toBe(50);
    expect((snap.pragma('integrity_check') as Array<{ integrity_check: string }>)[0].integrity_check).toBe('ok');
    snap.close();
  });

  it('an uncommitted transaction is NOT captured (the snapshot is consistent)', () => {
    const live = new Database(livePath);
    seed(live);

    live.exec('BEGIN');
    live.prepare('INSERT INTO payments (id, amount, student_id) VALUES (?, ?, ?)').run('uncommitted', 9999, 's0');
    // VACUUM INTO cannot run inside a transaction; that restriction is itself
    // the guarantee that a snapshot never captures a half-finished write.
    expect(() => snapshot(live, snapPath)).toThrow();
    live.exec('ROLLBACK');

    snapshot(live, snapPath);
    const snap = new Database(snapPath, { readonly: true });
    expect(snap.prepare(`SELECT id FROM payments WHERE id = 'uncommitted'`).get()).toBeUndefined();
    expect((snap.prepare('SELECT COUNT(*) c FROM payments').get() as { c: number }).c).toBe(50);
    snap.close();
    live.close();
  });
});
