#!/usr/bin/env node
/**
 * Post-deployment verification for a live database.
 *
 * Answers, against the REAL database an operator just deployed onto, the
 * questions that cannot be answered from a build environment:
 *
 *   - did every migration actually apply?
 *   - did migration 068's indexes land? (go-live blocker GL-4)
 *   - did migration 069's money guards land?
 *   - did migration 067 leave every branch reconciled?
 *   - is the pre-migration backup on disk?
 *   - is the database structurally intact (FK, integrity)?
 *
 * Read-only: it opens the database in readonly mode and writes nothing.
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

const migrationsOnDisk = (() => {
  // `new URL(import.meta.url).pathname` is NOT a filesystem path on Windows:
  // it yields '/C:/Users/...', which fs.existsSync() can never resolve. Both
  // candidate directories then looked absent, `migrationsOnDisk` came back
  // empty, nothing could be reported missing, and this check silently PASSED
  // on a database with unapplied migrations — the verifier's single most
  // important job, failing open. Reproduced: a database with 069 deleted from
  // schema_migrations exited 0 on Windows and 1 on Linux.
  // fileURLToPath() is the correct conversion on every platform.
  const scriptDir = path.dirname(fileURLToPath(import.meta.url));
  const dir = path.join(scriptDir, '..', 'src', 'db', 'migrations');
  const distDir = path.join(scriptDir, '..', 'dist', 'db', 'migrations');
  const useDir = fs.existsSync(dir) ? dir : distDir;
  return fs.existsSync(useDir) ? fs.readdirSync(useDir).filter((f) => f.endsWith('.sql')).sort() : [];
})();

check('every migration on disk is recorded as applied', () => {
  const applied = new Set(db.prepare('SELECT version FROM schema_migrations').all().map((r) => r.version));
  const missing = migrationsOnDisk.map((f) => f.replace(/\.sql$/, '')).filter((v) => !applied.has(v));
  return { ok: missing.length === 0, detail: missing.length ? `NOT applied: ${missing.join(', ')}` : `${applied.size} applied` };
});

check('GL-4: migration 068 indexes present', () => {
  const need = ['idx_users_role', 'idx_placement_profile_program_branch'];
  const missing = need.filter((n) =>
    db.prepare("SELECT COUNT(*) c FROM sqlite_master WHERE type='index' AND name=?").get(n).c === 0);
  return { ok: missing.length === 0, detail: missing.length ? `MISSING: ${missing.join(', ')}` : need.join(', ') };
});

check('users-by-role uses an index rather than scanning', () => {
  const plan = db.prepare('EXPLAIN QUERY PLAN SELECT * FROM users WHERE role = ?').all('owner')
    .map((r) => r.detail).join(' ');
  return { ok: plan.includes('idx_users_role'), detail: plan.trim() };
});

check('migration 069 money guards present', () => {
  const need = [
    'trg_invoices_nonnegative_insert', 'trg_invoices_nonnegative_update',
    'trg_student_semesters_nonnegative_insert', 'trg_student_semesters_nonnegative_update',
    'trg_exams_fee_nonnegative_insert', 'trg_exams_fee_nonnegative_update',
  ];
  const missing = need.filter((n) =>
    db.prepare("SELECT COUNT(*) c FROM sqlite_master WHERE type='trigger' AND name=?").get(n).c === 0);
  return { ok: missing.length === 0, detail: missing.length ? `MISSING: ${missing.join(', ')}` : `${need.length} triggers` };
});

check('migration 067: every branch reconciles to its ledger', () => {
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

check('pre-migration backup exists on disk', () => {
  const dir = path.join(path.dirname(path.resolve(dbPath)), 'backups');
  if (!fs.existsSync(dir)) return { ok: false, detail: `no backups directory at ${dir}` };
  const snaps = fs.readdirSync(dir).filter((f) => f.startsWith('pre-migration-') && f.endsWith('.sqlite'));
  return { ok: snaps.length > 0, detail: snaps.length ? `${snaps.length} snapshot(s), latest ${snaps.sort().at(-1)}` : 'none found' };
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
process.exit(failed ? 1 : 0);
