/**
 * System-wide integrity guards — regression suite
 * ============================================================================
 * These lock in defects found during the general system audit. They are
 * deliberately structural (schema/date/routing invariants) rather than
 * feature tests, because each one was a whole CLASS of silent failure:
 *
 *   G1. schema.sql must not drift from the migrated schema. A column that
 *       exists only after a migration makes a FRESH INSTALL crash on any
 *       route whose prepared statement selects it.
 *   G2. Payroll's "today" must agree with the `today()` written into date
 *       columns. Using UTC in one place and local time in the other caused a
 *       real off-by-one every evening in Kabul (UTC+04:30).
 *   G3. Every navigation entry must have a real route, or the user clicks a
 *       menu item and lands on "under development".
 */
import { describe, it, expect, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { db, initSchema } from '../db/connection.js';
import { gregorianToday } from '../core/payroll/class-payroll.js';
import { today } from '../utils/ids.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const serverRoot = path.resolve(__dirname, '..', '..');
const repoRoot = path.resolve(serverRoot, '..');
const schemaPath = path.join(serverRoot, 'src', 'db', 'schema.sql');

/** Tables that only migrations create — legitimately absent from schema.sql. */
const MIGRATION_ONLY_TABLES = new Set([
  'schema_migrations',
  'teacher_branch_history',
  'teacher_compensation_history',
]);

describe('G1 — schema.sql must not drift from the migrated schema', () => {
  it('every migrated column exists in schema.sql (fresh installs must work)', () => {
    initSchema(); // brings the shared test DB fully up to date

    const fresh = new Database(':memory:');
    try {
      fresh.exec(fs.readFileSync(schemaPath, 'utf8'));

      const migratedTables = (
        db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all() as Array<{ name: string }>
      ).map((r) => r.name);

      const drift: string[] = [];
      for (const table of migratedTables) {
        if (MIGRATION_ONLY_TABLES.has(table)) continue;
        const freshCols = new Set(
          (fresh.prepare(`PRAGMA table_info(${JSON.stringify(table)})`).all() as Array<{ name: string }>).map((c) => c.name)
        );
        if (!freshCols.size) continue; // table introduced by a migration
        for (const col of db.prepare(`PRAGMA table_info(${JSON.stringify(table)})`).all() as Array<{ name: string }>) {
          if (!freshCols.has(col.name)) drift.push(`${table}.${col.name}`);
        }
      }

      expect(drift, `schema.sql is missing migrated columns: ${drift.join(', ')}`).toEqual([]);
    } finally {
      fresh.close();
    }
  });

  it('columns the payroll/finance code selects exist in schema.sql alone', () => {
    const fresh = new Database(':memory:');
    try {
      fresh.exec(fs.readFileSync(schemaPath, 'utf8'));
      const probes = [
        'SELECT idempotency_key, status, voided_at, voided_by, void_reason FROM teacher_salary_ledger LIMIT 1',
        'SELECT requester_user_id, approved_by_user_id FROM expense_requests LIMIT 1',
        'SELECT components_json, scoring_model, allow_retake FROM placement_assessment_profiles LIMIT 1',
        'SELECT conditions_json FROM placement_rules LIMIT 1',
      ];
      for (const sql of probes) {
        expect(() => fresh.prepare(sql).all(), `fresh install would crash on: ${sql}`).not.toThrow();
      }
    } finally {
      fresh.close();
    }
  });
});

describe('G2 — date basis must be consistent across the system', () => {
  it('payroll today() agrees with the date written into records', () => {
    // Both must use the same calendar. A UTC/local split silently shifted
    // class-operational checks by a day every evening in Kabul.
    expect(gregorianToday()).toBe(today());
  });

  it('gregorianToday returns a valid ISO calendar date', () => {
    expect(gregorianToday()).toMatch(/^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/);
  });

  it('agrees with today() even late in the local evening (UTC+ off-by-one)', () => {
    // Time-independent proof: freeze the clock at 21:45 UTC, which is already
    // the NEXT calendar day in Kabul (UTC+04:30). A UTC-based implementation
    // returns the previous day here and disagrees with today() — the bug.
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date('2026-08-15T21:45:00Z'));
      expect(gregorianToday()).toBe(today());
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('G3 — every navigation entry resolves to a real route', () => {
  it('no navigation id falls through to the "under development" placeholder', () => {
    const nav = fs.readFileSync(path.join(repoRoot, 'src', 'config', 'navigation.ts'), 'utf8');
    const app = fs.readFileSync(path.join(repoRoot, 'src', 'App.tsx'), 'utf8');
    const ids = [...nav.matchAll(/\{\s*id:\s*'([^']+)',\s*label:\s*'[^']+',\s*icon:/g)].map((m) => m[1]);

    expect(ids.length).toBeGreaterThan(0);
    const orphaned = ids.filter((id) => id !== 'dashboard' && !new RegExp(`case '${id}':`).test(app));
    expect(orphaned, `navigation items with no App route: ${orphaned.join(', ')}`).toEqual([]);
  });
});
