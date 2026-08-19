#!/usr/bin/env node
/**
 * LEGACY CONFIGURATION DATA AUDIT — strictly READ-ONLY.
 *
 * Closing CFG-1..CFG-4 fixed the WRITE paths. It did not touch rows that were
 * already stored. This tool inventories that legacy state so the two remaining
 * data-state risks can be resolved or explicitly bounded:
 *
 *   RISK 1  branch_academic_profiles rows holding a fee the new validation
 *           would now reject (negative, sub-cent, non-finite, TEXT/BLOB,
 *           beyond canonical monetary precision).
 *   RISK 2  students.discount_percent > 20 with no valid authorization behind
 *           it, which the resolver will now fail closed to 20 on the next
 *           charge.
 *
 * It opens the database READONLY and never writes. It reuses the real
 * `assertMoney` and the real `resolveFee`, so the verdict is exactly what
 * production would do — not a reimplementation that could drift.
 *
 * Usage (the tsx loader is required because it imports the real TypeScript
 * authorities rather than copying their rules):
 *   npx tsx scripts/legacy-config-data-audit.mjs [--db path/to/erp.sqlite] [--json]
 *   npm run audit:legacy-config -- --db /path/to/erp.sqlite
 *
 * Exit codes:
 *   0  no malformed legacy data found
 *   1  malformed legacy data found — a business decision is required
 *   2  the database could not be opened
 */
import { existsSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const argv = process.argv.slice(2);
const arg = (flag, fallback) => {
  const i = argv.indexOf(flag);
  return i !== -1 && argv[i + 1] ? argv[i + 1] : fallback;
};
const asJson = argv.includes('--json');
const dbPath = path.resolve(arg('--db', process.env.DB_PATH || './data/erp.sqlite'));

if (!existsSync(dbPath)) {
  console.error(`\nNo database at ${dbPath}`);
  console.error('Point the audit at a real deployment:\n  node scripts/legacy-config-data-audit.mjs --db /path/to/erp.sqlite\n');
  process.exit(2);
}

const { default: Database } = await import('better-sqlite3');
const db = new Database(dbPath, { readonly: true, fileMustExist: true });

// Reuse the CANONICAL authorities rather than reimplementing their boundaries.
const serverSrc = path.resolve(import.meta.dirname, '..', 'src');
const { assertMoney } = await import(pathToFileURL(path.join(serverSrc, 'utils', 'money.js')).href);
const { resolveFee } = await import(pathToFileURL(path.join(serverSrc, 'core', 'configuration', 'policy-resolver.js')).href);
const { ORDINARY_MAX, CATEGORY_MAX } = await import(
  pathToFileURL(path.join(serverSrc, 'core', 'configuration', 'discount-authority.js')).href
);

const has = (table) =>
  !!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table);

// ── RISK 1 · legacy fee configuration ───────────────────────────────────────
const FEE_FIELDS = [
  ['placement_test_fee', 'placementTestFee', 'placement test fee'],
  ['registration_fee', 'registrationFee', 'registration fee'],
  ['card_fee', 'cardIssuanceFee', 'card fee'],
  ['diploma_fee', 'diplomaFee', 'diploma fee'],
];

const feeFindings = [];
let profileRows = 0;

if (has('branch_academic_profiles')) {
  const rows = db
    .prepare(
      `SELECT branch_id,
              placement_test_fee, typeof(placement_test_fee) AS t_placement_test_fee,
              registration_fee,   typeof(registration_fee)   AS t_registration_fee,
              card_fee,           typeof(card_fee)           AS t_card_fee,
              diploma_fee,        typeof(diploma_fee)        AS t_diploma_fee,
              default_pass_mark, default_min_attendance
         FROM branch_academic_profiles`,
    )
    .all();
  profileRows = rows.length;

  for (const row of rows) {
    for (const [column, feeKey, label] of FEE_FIELDS) {
      const raw = row[column];
      const storage = row[`t_${column}`];

      // What the NEW write validation would decide about this stored value.
      let accepted = true;
      let reason = '';
      try {
        const canonical = assertMoney(raw, label);
        // The route additionally refuses a number that is not exact money
        // (it would otherwise be silently rounded to a different fee).
        if (typeof raw === 'number' && raw !== canonical) {
          accepted = false;
          reason = `sub-cent / not exact money (would round ${raw} -> ${canonical})`;
        }
      } catch (err) {
        accepted = false;
        reason = err?.message ?? String(err);
      }

      // What production would actually charge with this row in place.
      const resolved = resolveFee(db, row.branch_id, feeKey);

      if (!accepted || storage !== 'real' || (typeof raw === 'number' && raw < 0)) {
        feeFindings.push({
          branch_id: row.branch_id,
          field: column,
          raw,
          storage,
          resolved,
          classification: !accepted
            ? 'MALFORMED — new validation would reject this value'
            : `STORAGE ANOMALY — typeof=${storage}, expected real`,
          reason,
        });
      }
    }
  }
}

// ── RISK 2 · legacy discount state ──────────────────────────────────────────
const discountFindings = [];
let overCeiling = 0;

if (has('students')) {
  const students = db
    .prepare(
      `SELECT id, student_code, full_name, branch_id, discount_percent
         FROM students
        WHERE discount_percent IS NOT NULL AND CAST(discount_percent AS REAL) > ?`,
    )
    .all(ORDINARY_MAX);
  overCeiling = students.length;

  const authTableExists = has('student_discount_authorizations');
  const today = new Date().toISOString().slice(0, 10);

  for (const s of students) {
    const auths = authTableExists
      ? db
          .prepare(
            `SELECT id, category, approved_percent, status, effective_from, effective_to, branch_id
               FROM student_discount_authorizations WHERE student_id = ?`,
          )
          .all(s.id)
      : [];

    // A grant only counts if it is live, in date, and in the student's branch.
    const live = auths.filter(
      (a) =>
        a.status === 'active' &&
        (!a.effective_from || a.effective_from <= today) &&
        (!a.effective_to || a.effective_to >= today) &&
        a.branch_id === s.branch_id,
    );

    const best = live.reduce((acc, a) => {
      const cap = Math.min(Number(a.approved_percent) || 0, CATEGORY_MAX[a.category] ?? ORDINARY_MAX);
      return cap > (acc?.cap ?? -1) ? { auth: a, cap } : acc;
    }, null);

    // Historical money already issued against this student.
    const invoices = has('invoices')
      ? db.prepare('SELECT COUNT(*) c FROM invoices WHERE student_id = ?').get(s.id).c
      : 0;
    const payments = has('payments')
      ? db.prepare('SELECT COUNT(*) c FROM payments WHERE student_id = ?').get(s.id).c
      : 0;
    const semesters = has('student_semesters')
      ? db.prepare('SELECT COUNT(*) c FROM student_semesters WHERE student_id = ?').get(s.id).c
      : 0;
    const hasHistory = invoices + payments + semesters > 0;

    const resolverWouldAllow = best ? best.cap : ORDINARY_MAX;
    const stored = Number(s.discount_percent);

    let classification;
    if (best && stored <= best.cap) {
      classification = 'A · VALIDLY AUTHORIZED — preserve';
    } else if (best && stored > best.cap) {
      classification = `C · AMBIGUOUS — authorized ${best.auth.category} caps at ${best.cap}%, stored ${stored}%`;
    } else if (hasHistory) {
      classification = 'D · HISTORICAL EFFECT — no authorization; history preserved, future pricing falls to 20%';
    } else {
      classification = 'B · UNAUTHORIZED — fails closed to 20% on next charge';
    }

    discountFindings.push({
      student_id: s.id,
      student_code: s.student_code,
      branch_id: s.branch_id,
      stored_discount: stored,
      authorization: best ? best.auth.category : null,
      max_allowed: resolverWouldAllow,
      approval_status: best ? best.auth.status : auths.length ? 'no live grant' : 'none',
      resolver_would_permit: resolverWouldAllow,
      historical_invoices: invoices,
      historical_payments: payments,
      historical_semesters: semesters,
      classification,
    });
  }
}

const report = {
  database: dbPath,
  generated_at: new Date().toISOString(),
  fee_audit: { profiles_scanned: profileRows, malformed: feeFindings.length, findings: feeFindings },
  discount_audit: {
    students_over_ceiling: overCeiling,
    findings: discountFindings,
    counts: discountFindings.reduce((acc, f) => {
      const k = f.classification[0];
      acc[k] = (acc[k] ?? 0) + 1;
      return acc;
    }, {}),
  },
};

if (asJson) {
  console.log(JSON.stringify(report, null, 2));
} else {
  console.log(`\nLEGACY CONFIGURATION DATA AUDIT (read-only)\n  ${dbPath}\n`);
  console.log(`RISK 1 · branch_academic_profiles — ${profileRows} row(s) scanned`);
  if (!feeFindings.length) {
    console.log('  no malformed fee configuration found\n');
  } else {
    console.log('  branch_id | field | raw | storage | resolved | classification');
    for (const f of feeFindings) {
      console.log(`  ${f.branch_id} | ${f.field} | ${String(f.raw)} | ${f.storage} | ${f.resolved} | ${f.classification}${f.reason ? ` (${f.reason})` : ''}`);
    }
    console.log('');
  }

  console.log(`RISK 2 · students.discount_percent > ${ORDINARY_MAX} — ${overCeiling} student(s)`);
  if (!discountFindings.length) {
    console.log('  no student holds a discount above the ordinary ceiling\n');
  } else {
    for (const d of discountFindings) {
      console.log(
        `  ${d.student_code ?? d.student_id} (${d.branch_id}) stored=${d.stored_discount}% ` +
          `auth=${d.authorization ?? 'NONE'} max=${d.max_allowed}% ` +
          `history[inv=${d.historical_invoices} pay=${d.historical_payments} sem=${d.historical_semesters}] ` +
          `=> ${d.classification}`,
      );
    }
    console.log('\n  counts by class:', JSON.stringify(report.discount_audit.counts));
    console.log('');
  }
}

const dirty = feeFindings.length + discountFindings.length;
if (dirty) {
  console.error(`Malformed or unauthorized legacy state found (${dirty} finding(s)).`);
  console.error('This tool does NOT repair data. Classify each finding and obtain the business decision.');
}
process.exit(dirty ? 1 : 0);
