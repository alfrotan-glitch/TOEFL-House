#!/usr/bin/env node
/**
 * Post-deployment verification for a live database.
 *
 * Answers, against the REAL database an operator just deployed onto, the
 * questions that cannot be answered from a build environment:
 *
 *   - does the live database actually match the canonical schema?
 *   - are the financial integrity guards present?
 *   - does every branch reconcile to its ledger?
 *   - is the database structurally intact (FK, integrity)?
 *
 * The schema comparison is direct: the canonical schema is applied to a
 * throwaway in-memory database and the two shapes are diffed. That is
 * strictly stronger than asking a bookkeeping table whether it believes the
 * schema is current, because it inspects the database that actually exists.
 *
 * Read-only: it opens the deployed database in readonly mode and writes
 * nothing.
 *
 *   node scripts/verify-deployment.mjs [path/to/erp.sqlite]
 *
 * Exit 0 = all checks passed, 1 = at least one failed, 2 = cannot read the db.
 */
import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const dbPath = process.argv[2] || process.env.DB_PATH || path.join('data', 'erp.sqlite');

if (!fs.existsSync(dbPath)) {
  console.error(`Deployment verification: database not found at ${dbPath}`);
  console.error('  node scripts/verify-deployment.mjs /path/to/erp.sqlite');
  process.exit(2);
}

let db;
try {
  db = new Database(dbPath, { readonly: true });
  db.prepare('SELECT 1').get();
} catch (err) {
  console.error(`Deployment verification: cannot read ${dbPath} — ${err.message}`);
  process.exit(2);
}

const results = [];
const check = (name, fn) => {
  try {
    const { ok, detail } = fn();
    results.push({ name, ok, detail });
  } catch (err) {
    results.push({ name, ok: false, detail: `check threw: ${err.message}` });
  }
};

/**
 * The canonical schema, materialized in memory for comparison.
 *
 * Resolved with fileURLToPath rather than `new URL(...).pathname`: on Windows
 * the latter yields '/C:/Users/...', which fs can never resolve, so the
 * reference schema would silently come back empty and every structural check
 * would pass vacuously — the verifier failing open at exactly the moment it
 * matters most.
 */
const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const canonical = (() => {
  const src = path.join(scriptDir, '..', 'src', 'db', 'schema.sql');
  const dist = path.join(scriptDir, '..', 'dist', 'db', 'schema.sql');
  const use = fs.existsSync(src) ? src : dist;
  if (!fs.existsSync(use)) return null;
  const mem = new Database(':memory:');
  mem.pragma('foreign_keys = OFF');
  mem.exec(fs.readFileSync(use, 'utf8'));
  return mem;
})();

const objectsOf = (handle, type) =>
  new Set(
    handle
      .prepare("SELECT name FROM sqlite_master WHERE type = ? AND name NOT LIKE 'sqlite_%'")
      .all(type)
      .map((r) => r.name)
  );

const structural = (type) => () => {
  if (!canonical) return { ok: false, detail: 'canonical schema.sql could not be located' };
  const expected = objectsOf(canonical, type);
  const actual = objectsOf(db, type);
  const missing = [...expected].filter((n) => !actual.has(n)).sort();
  return {
    ok: missing.length === 0,
    detail: missing.length ? `MISSING ${missing.length}: ${missing.join(', ')}` : `${expected.size} present`,
  };
};

check('every canonical table exists', structural('table'));
check('every canonical index exists', structural('index'));
check('every canonical trigger exists', structural('trigger'));

check('live database has no table beyond the canonical schema', () => {
  if (!canonical) return { ok: false, detail: 'canonical schema.sql could not be located' };
  const expected = objectsOf(canonical, 'table');
  const extra = [...objectsOf(db, 'table')].filter((n) => !expected.has(n)).sort();
  return {
    ok: extra.length === 0,
    detail: extra.length ? `UNKNOWN tables present: ${extra.join(', ')}` : 'no drift',
  };
});

check('every canonical column exists on every table', () => {
  if (!canonical) return { ok: false, detail: 'canonical schema.sql could not be located' };
  const drift = [];
  for (const table of objectsOf(canonical, 'table')) {
    const want = canonical.prepare(`PRAGMA table_info(${JSON.stringify(table)})`).all().map((c) => c.name);
    const have = new Set(db.prepare(`PRAGMA table_info(${JSON.stringify(table)})`).all().map((c) => c.name));
    for (const column of want) if (!have.has(column)) drift.push(`${table}.${column}`);
  }
  return { ok: drift.length === 0, detail: drift.length ? `MISSING: ${drift.join(', ')}` : 'no drift' };
});

check('every branch reconciles to its ledger', () => {
  // Mirrors computeReconciliation: capital_injection credits the organization
  // treasury, not branch cash, so it is excluded from the branch figure.
  const rows = db.prepare(`
    SELECT fa.scope_id AS branch, fa.main_balance AS actual_main, fa.saving_balance AS actual_saving,
      COALESCE((SELECT SUM(CASE WHEN ft.type='income' AND ft.category <> 'capital_injection' THEN ft.amount
                                WHEN ft.type='saving_transfer' THEN -ft.amount ELSE 0 END)
                FROM financial_transactions ft WHERE ft.branch_id = fa.scope_id), 0) AS expected_main,
      COALESCE((SELECT SUM(ft.amount) FROM financial_transactions ft
                WHERE ft.branch_id = fa.scope_id AND ft.type='saving_transfer'), 0) AS expected_saving
    FROM finance_accounts fa WHERE fa.scope_type = 'branch'`).all();
  const bad = rows.filter((r) =>
    Math.abs(r.actual_main - r.expected_main) > 0.005 || Math.abs(r.actual_saving - r.expected_saving) > 0.005);
  return {
    ok: bad.length === 0,
    detail: bad.length
      ? bad.map((b) => `branch ${b.branch}: cash ${b.actual_main} vs ledger ${b.expected_main}`).join('; ')
      : `${rows.length} branch account(s) reconciled`,
  };
});

check('foreign key integrity', () => {
  const v = db.pragma('foreign_key_check');
  return { ok: v.length === 0, detail: `${v.length} violation(s)` };
});

check('database integrity_check', () => {
  const r = db.pragma('integrity_check')[0].integrity_check;
  return { ok: r === 'ok', detail: r };
});

console.log('Deployment verification (READ-ONLY)');
console.log(`  database: ${dbPath}\n`);
let failed = 0;
for (const r of results) {
  if (!r.ok) failed += 1;
  console.log(`  ${r.ok ? 'PASS' : 'FAIL'}  ${r.name}`);
  console.log(`        ${r.detail}`);
}
console.log('');
console.log(`  ${results.length - failed} passed · ${failed} failed`);
if (failed) {
  console.log('\n  DEPLOYMENT NOT VERIFIED — investigate before putting the system into use.');
}
db.close();
canonical?.close();
process.exit(failed ? 1 : 0);
