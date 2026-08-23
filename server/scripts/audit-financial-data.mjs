#!/usr/bin/env node
/**
 * Read-only audit of stored financial values.
 *
 * WHY THIS EXISTS
 * ---------------
 * A database copied from an incompatible or externally altered environment can
 * hold values that current writers reject: a literal string in a money column,
 * NULL where an amount is required, negatives, sub-unit fractions, or figures
 * beyond supported monetary precision. Current entry points and schema guards
 * prevent new corruption, but this audit never rewrites history. Silently
 * "correcting" a financial record would destroy the evidence of what happened.
 *
 * This script therefore only LOOKS. It never writes, never migrates, and never
 * deletes. Run it against a production copy before go-live to find out whether
 * any repair is needed and, if so, exactly which rows a human must decide on.
 *
 *   node scripts/audit-financial-data.mjs [path/to/erp.sqlite]
 *
 * Exit code 0 = clean, 1 = suspect rows found (so CI or a deploy script can
 * gate on it).
 */
import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';

const dbPath = process.argv[2] || process.env.DB_PATH || path.join('data', 'erp.sqlite');

/** table -> columns that hold money and must never be corrupt. */
const MONEY_COLUMNS = {
  payments: ['amount'],
  financial_transactions: ['amount'],
  finance_accounts: ['main_balance', 'saving_balance'],
  invoices: ['total_amount', 'discount_amount', 'net_amount'],
  invoice_items: ['unit_price', 'amount'],
  book_sales: ['unit_price', 'gross_amount', 'discount_amount', 'net_amount'],
  books: ['sale_price', 'default_unit_cost'],
  book_stock_receipts: ['unit_cost'],
  student_semesters: ['fee_amount', 'net_fee_amount'],
  teacher_salary_ledger: ['due_amount', 'paid_amount'],
  teachers: ['base_salary', 'default_skill_rate'],
  employees: ['base_salary'],
  budget_lines: ['current_amount', 'allocated_amount'],
  levels: ['default_fee'],
  classes: ['fee'],
  exams: ['fee'],
  scholarships: ['total_budget', 'allocated_amount'],
  scholarship_awards: ['amount'],
  funding_campaigns: ['target_amount'],
  donations: ['amount'],
  sponsorship_agreements: ['monthly_amount'],
  expense_requests: ['amount'],
};

/** Columns where a negative value is legitimate (contra rows, adjustments). */
const NEGATIVE_ALLOWED = new Set(['payments.amount', 'financial_transactions.amount']);

// A missing or unreadable database must be a LOUD failure, not a silent pass.
// The first version let better-sqlite3 throw a raw stack trace while the
// process still exited 0, so a deploy gate reading the exit code would have
// treated "I could not look at all" as "I looked and it was clean".
if (!fs.existsSync(dbPath)) {
  console.error(`Financial data audit: database not found at ${dbPath}`);
  console.error('Pass the path explicitly, e.g.');
  console.error('  node scripts/audit-financial-data.mjs /var/lib/toefl-house/erp.sqlite');
  process.exit(2);
}

let db;
try {
  db = new Database(dbPath, { readonly: true });
  db.prepare('SELECT 1').get();
} catch (err) {
  console.error(`Financial data audit: cannot read ${dbPath} — ${err.message}`);
  process.exit(2);
}
const tableExists = (t) =>
  db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(t) !== undefined;
const columnExists = (t, c) =>
  db.prepare(`PRAGMA table_info("${t}")`).all().some((r) => r.name === c);

const findings = [];
let checkedColumns = 0;
let checkedRows = 0;

/**
 * What a corrupt value in this column actually costs, so the human deciding
 * on it has the blast radius in front of them rather than having to infer it.
 */
const BLAST_RADIUS = {
  'payments.amount': 'Student balance, receipts, reconciliation cashVariance.',
  'financial_transactions.amount': 'THE LEDGER — every income/expense total, reconciliation, and finance dashboard figure.',
  'finance_accounts.main_balance': 'Branch cash position shown to operators; reconciliation cashVariance.',
  'finance_accounts.saving_balance': 'Branch savings position; reconciliation savingVariance.',
  'invoices.total_amount': 'Student outstanding obligation and printed fee bill.',
  'invoices.discount_amount': 'Net payable on the invoice and the printed bill.',
  'invoices.net_amount': 'Amount the student is actually asked to pay.',
  'invoice_items.unit_price': 'Invoice line total, then the invoice net.',
  'invoice_items.amount': 'Invoice total and net.',
  'book_sales.unit_price': 'The price snapshot for one posted Book sale copy.',
  'book_sales.gross_amount': 'Book sale gross receipt before the explicit discount.',
  'book_sales.discount_amount': 'The recorded Book sale discount.',
  'book_sales.net_amount': 'Linked Book-sale payment and income amount; it is the full-return ceiling.',
  'books.sale_price': 'The configured price for every future sale of this catalog item.',
  'books.default_unit_cost': 'Optional Book receipt cost reference; it never creates a cash movement.',
  'book_stock_receipts.unit_cost': 'Optional immutable stock-receipt cost reference; it never creates a cash movement.',
  'student_semesters.fee_amount': 'Tuition owed by the student; drives outstanding balance.',
  'student_semesters.net_fee_amount': 'Tuition after discount — what the student is billed.',
  'teacher_salary_ledger.due_amount': 'Payroll remaining-due calculation; can block or over-permit payment.',
  'teacher_salary_ledger.paid_amount': 'Payroll history and expense totals.',
  'teachers.base_salary': 'Future payroll due amounts for this teacher.',
  'employees.base_salary': 'Future payroll due amounts for this employee.',
  'budget_lines.current_amount': 'Spending capacity; payroll and expenses are refused when insufficient.',
  'levels.default_fee': 'SOURCE of class fees, therefore of tuition for every future enrolment at this level.',
  'classes.fee': 'Tuition for every future enrolment into this class.',
  'exams.fee': 'Exam charge applied to future candidates.',
  'scholarships.total_budget': 'Award budget check — a non-numeric budget makes remaining NaN and every award comparison pass.',
  'scholarship_awards.amount': 'Scholarship allocation and student benefit records.',
  'funding_campaigns.target_amount': 'Campaign progress reporting only; no cash effect.',
  'donations.amount': 'Donation income and the ledger.',
  'sponsorship_agreements.monthly_amount': 'Recurring sponsorship billing.',
  'expense_requests.amount': 'Budget deduction when the request is approved.',
};

/** Columns whose value is reporting-only: wrong is ugly, not dangerous. */
const REPORTING_ONLY = new Set([
  'books.default_unit_cost',
  'book_stock_receipts.unit_cost',
  'funding_campaigns.target_amount',
]);

/** Pull up to `limit` offending record ids so a human can inspect them. */
function sampleRows(table, col, predicate, limit = 5) {
  const idCol = db.prepare(`PRAGMA table_info("${table}")`).all().some((r) => r.name === 'id') ? 'id' : 'rowid';
  try {
    return db.prepare(
      `SELECT "${idCol}" AS rid, "${col}" AS val FROM "${table}" WHERE ${predicate} LIMIT ${limit}`
    ).all();
  } catch {
    return [];
  }
}

for (const [table, columns] of Object.entries(MONEY_COLUMNS)) {
  if (!tableExists(table)) continue;
  const rowCount = db.prepare(`SELECT COUNT(*) c FROM "${table}"`).get().c;
  for (const col of columns) {
    if (!columnExists(table, col)) continue;
    checkedColumns += 1;
    checkedRows += rowCount;
    const key = `${table}.${col}`;

    // Non-numeric storage: SQLite is dynamically typed, so a TEXT price is
    // possible even in a REAL column. This is the 'abc' case.
    const nonNumeric = db.prepare(
      `SELECT COUNT(*) c FROM "${table}" WHERE "${col}" IS NOT NULL AND typeof("${col}") NOT IN ('integer','real')`
    ).get().c;
    const nonNumericPred = `"${col}" IS NOT NULL AND typeof("${col}") NOT IN ('integer','real')`;
    if (nonNumeric) findings.push({ key, table, col, issue: 'non-numeric value stored', count: nonNumeric, severity: 'CRITICAL', rows: sampleRows(table, col, nonNumericPred) });

    const nulls = db.prepare(`SELECT COUNT(*) c FROM "${table}" WHERE "${col}" IS NULL`).get().c;
    if (nulls) findings.push({ key, table, col, issue: 'NULL amount', count: nulls, severity: 'HIGH', rows: sampleRows(table, col, `"${col}" IS NULL`) });

    if (!NEGATIVE_ALLOWED.has(key)) {
      const negative = db.prepare(
        `SELECT COUNT(*) c FROM "${table}" WHERE typeof("${col}") IN ('integer','real') AND "${col}" < 0`
      ).get().c;
      if (negative) findings.push({ key, table, col, issue: 'negative amount', count: negative, severity: 'HIGH', rows: sampleRows(table, col, `typeof("${col}") IN ('integer','real') AND "${col}" < 0`) });
    }

    // Sub-cent precision: a value that is not equal to itself rounded to 2dp.
    const subCent = db.prepare(
      `SELECT COUNT(*) c FROM "${table}"
       WHERE typeof("${col}") IN ('integer','real') AND ABS("${col}" - ROUND("${col}", 2)) > 0.0000001`
    ).get().c;
    if (subCent) findings.push({ key, table, col, issue: 'more than two decimal places', count: subCent, severity: 'MEDIUM', rows: sampleRows(table, col, `typeof("${col}") IN ('integer','real') AND ABS("${col}" - ROUND("${col}", 2)) > 0.0000001`) });

    // Beyond safe monetary precision (cents must stay a safe integer).
    const tooLarge = db.prepare(
      `SELECT COUNT(*) c FROM "${table}"
       WHERE typeof("${col}") IN ('integer','real') AND ABS("${col}") > 90000000000`
    ).get().c;
    if (tooLarge) findings.push({ key, table, col, issue: 'exceeds supported monetary precision', count: tooLarge, severity: 'HIGH', rows: sampleRows(table, col, `typeof("${col}") IN ('integer','real') AND ABS("${col}") > 90000000000`) });
  }
}

console.log('Financial data audit (READ-ONLY — nothing was modified)');
console.log(`  database : ${dbPath}`);
console.log(`  columns  : ${checkedColumns} money columns inspected`);
console.log(`  rows     : ${checkedRows} column-rows scanned`);
console.log('');

if (findings.length === 0) {
  console.log('  RESULT: clean — no corrupt monetary values found.');
  db.close();
  process.exit(0);
}

const order = { CRITICAL: 0, HIGH: 1, MEDIUM: 2 };
findings.sort((a, b) => order[a.severity] - order[b.severity] || a.key.localeCompare(b.key));
console.log(`  RESULT: ${findings.length} issue group(s) found. A HUMAN must decide on each —`);
console.log('  this script does not repair anything, by design.');
console.log('');
for (const f of findings) {
  console.log(`[${f.severity}] ${f.key} — ${f.issue} (${f.count} row(s))`);
  console.log(`   blast radius : ${BLAST_RADIUS[f.key] || 'Unclassified financial field — treat as cash-affecting until reviewed.'}`);
  console.log(`   safe to leave: ${REPORTING_ONLY.has(f.key) ? 'YES for cash correctness — reporting-only field. Still review before trusting reports.' : 'NO — this value feeds a cash or obligation figure. A human must decide.'}`);
  const shown = f.rows.map((r) => `${r.rid}=${JSON.stringify(r.val)}`).join(', ');
  if (shown) console.log(`   record ids   : ${shown}${f.count > f.rows.length ? ` … and ${f.count - f.rows.length} more` : ''}`);
  console.log('');
}
console.log('  Required human decision for each row above: correct it with a documented');
console.log('  adjustment, or accept it and record why. Do NOT edit history silently.');
db.close();
process.exit(1);
