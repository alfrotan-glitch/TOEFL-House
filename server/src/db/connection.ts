import type BetterSqlite3 from 'better-sqlite3';
/**
 * SQLite connection and canonical database initialization.
 *
 * There is no migration chain. `schema.sql` is the single canonical
 * representation of the database, and initialization is:
 *
 *   EMPTY DATABASE -> CANONICAL SCHEMA -> ORGANIZATION HIERARCHY -> READY
 *
 * The schema is written with CREATE ... IF NOT EXISTS throughout, so applying
 * it to a database already at this canonical shape is a no-op and startup stays
 * idempotent. It is not a migration mechanism for an incompatible predecessor
 * shape; greenfield reconstruction uses a clean database rebuild.
 */
import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ensureOrganizationHierarchy } from './organizationHierarchy.js';
import { setFinanceAccountsDatabase } from '../utils/financeAccounts.js';
import { createLogger } from '../core/observability/logger.js';
import { assertMoney } from '../utils/money.js';
const log = createLogger('connection');

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const DB_PATH = process.env.DB_PATH || './data/erp.sqlite';

// Ensure the directory for the SQLite file exists
const dbDir = path.dirname(DB_PATH);
if (dbDir && dbDir !== '.' && !fs.existsSync(dbDir)) {
  fs.mkdirSync(dbDir, { recursive: true });
}

export const db: BetterSqlite3.Database = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');
// A second process sharing the database file (an operator running a script
// against the live DB) would otherwise surface immediate SQLITE_BUSY 500s
// instead of waiting for the writer. Harmless in the designed
// single-instance deployment; cheap insurance everywhere else.
db.pragma('busy_timeout = 5000');

/**
 * Verifies the database matches the canonical schema and is internally sound.
 *
 * Applying the schema is not by itself proof that the result is usable: a
 * database that predates a schema edit satisfies every `IF NOT EXISTS` while
 * still missing the new column, and the failure would otherwise surface much
 * later as a prepared-statement error on an unrelated route. Checking here
 * fails fast, at startup, with the reason.
 */
function verifyCanonicalState(): void {
  const integrity = db.pragma('integrity_check', { simple: true }) as string;
  if (integrity !== 'ok') {
    throw new Error(`SQLite integrity_check failed: ${integrity}`);
  }

  const violations = db.pragma('foreign_key_check') as unknown[];
  if (violations.length > 0) {
    throw new Error(`SQLite foreign_key_check failed with ${violations.length} violation(s)`);
  }
}

/**
 * Reconciles placement-only schema objects with the current canonical state.
 *
 * SQLite keeps existing CREATE TRIGGER IF NOT EXISTS bodies, so placement
 * triggers that changed in the canonical schema are dropped here and recreated
 * from schema.sql on the same startup. Placement-only objects that are absent
 * from the canonical schema are removed so the active database has one
 * placement authority.
 */
function reconcileCanonicalPlacementState(): void {
  db.exec(`
    DROP TABLE IF EXISTS placement_rules;
    DROP TRIGGER IF EXISTS trg_placement_rule_require_branch;
    DROP TRIGGER IF EXISTS trg_placement_rule_sync_level_code;
    DROP TRIGGER IF EXISTS trg_placement_rule_code_update;
    DROP TRIGGER IF EXISTS trg_placement_test_rubric_scope_insert;
    DROP TRIGGER IF EXISTS trg_placement_test_rubric_scope_update;
    DROP TRIGGER IF EXISTS trg_placement_rubric_kind_scope_update;
    DROP TRIGGER IF EXISTS trg_placement_attempt_scope_insert;
    DROP TRIGGER IF EXISTS trg_placement_attempt_scope_update;
  `);
}

/**
 * Copies retired branch-profile fixed-fee values into the canonical fee-rule
 * registry only when a branch has no explicit rule for that fee type.
 *
 * The branch-profile columns remain storage-only; transactions and reads use
 * the canonical registry. Any non-canonical stored amount is left unresolved so
 * the live fee resolver blocks the charge instead of guessing one.
 */
/**
 * Converge a pre-canonical database onto the registrations shape: the
 * amount_paid / receipt_number / discount_applied columns were financial
 * LOOKALIKES — every production writer stored 0/NULL/0, so any reader (the
 * dashboard's registration-discount leg, direct SQL) was reading fiction.
 * They are dropped; the authorities (payments, invoices) keep the facts.
 */
function ensureRegistrationsFinancialColumnsDropped(): void {
  const columns = db.prepare(`PRAGMA table_info(registrations)`).all() as Array<{ name: string }>;
  for (const dead of ['amount_paid', 'receipt_number', 'discount_applied']) {
    if (columns.some((column) => column.name === dead)) {
      db.exec(`ALTER TABLE registrations DROP COLUMN ${dead}`);
    }
  }
}

function ensureInvoiceChargeKindColumn(): void {
  const columns = db.prepare(`PRAGMA table_info(invoices)`).all() as Array<{ name: string }>;
  if (!columns.some((column) => column.name === 'charge_kind')) {
    db.exec(`ALTER TABLE invoices ADD COLUMN charge_kind TEXT`);
  }
}

/**
 * W17 (F9): converge a pre-W17 `payments` table onto the payer-attribution
 * shape. Attribution is optional detail; rows recorded before attribution
 * existed keep NULL, which is exactly their meaning ("no third-party
 * attribution recorded").
 */
function ensurePaymentsPayerColumns(): void {
  const columns = db.prepare(`PRAGMA table_info(payments)`).all() as Array<{ name: string }>;
  if (!columns.some((column) => column.name === 'payer_name')) {
    db.exec(`ALTER TABLE payments ADD COLUMN payer_name TEXT`);
  }
  if (!columns.some((column) => column.name === 'payer_relation')) {
    db.exec(`ALTER TABLE payments ADD COLUMN payer_relation TEXT`);
  }
}

/**
 * Converge a pre-W6.1 database onto the acquisition-accounting shape of
 * `book_stock_receipts`: the purchase declaration and the paying transaction
 * are new columns. Rows recorded before declaration accounting keep NULL —
 * pre-declaration history, reported as such by the books reconciliation
 * rather than rewritten.
 */
function ensureBookReceiptAcquisitionColumns(): void {
  const columns = db.prepare(`PRAGMA table_info(book_stock_receipts)`).all() as Array<{ name: string }>;
  if (!columns.some((column) => column.name === 'purchase_declaration')) {
    db.exec(`ALTER TABLE book_stock_receipts ADD COLUMN purchase_declaration TEXT`);
  }
  if (!columns.some((column) => column.name === 'purchase_transaction_id')) {
    db.exec(`ALTER TABLE book_stock_receipts ADD COLUMN purchase_transaction_id TEXT REFERENCES financial_transactions(id) ON DELETE RESTRICT`);
  }
}


/**
 * W16 evolution: widen `financial_transactions.type` with the P&L-neutral
 * 'restricted_reclaim' evidence type for donation-clawback repayments.
 *
 * SQLite cannot ALTER a CHECK constraint, so an existing (pre-W16) table is
 * rebuilt with the standard copy-swap procedure while `foreign_keys` is OFF
 * (initSchema guarantees that). The canonical DDL is extracted from
 * schema.sql itself — never duplicated here — and the idempotent schema
 * re-run afterwards recreates the indexes and triggers that died with the
 * old table. Greenfield databases already carry the new CHECK and skip this.
 */
/**
 * W18 (D-187): converge a pre-W18 `donation_clawbacks` table onto the
 * attribution shape. A declaration from before attribution existed only ever
 * succeeded when the donation had NO onward instrument movement, so its
 * attribution is derivable: the donation's single root instrument. NULL
 * survives only where
 * no unique root exists (not producible through the service; defensive).
 */
function ensureDonationClawbackAttributionColumns(): void {
  const columns = db.prepare(`PRAGMA table_info(donation_clawbacks)`).all() as Array<{ name: string }>;
  if (!columns.some((column) => column.name === 'attributed_id')) {
    db.exec(`ALTER TABLE donation_clawbacks ADD COLUMN attributed_kind TEXT`);
    db.exec(`ALTER TABLE donation_clawbacks ADD COLUMN attributed_id TEXT`);
  }
  // Backfill: one root instrument ⇒ attribute to it. The W16 immutability
  // trigger correctly refuses ANY update to an open/repaid clawback, so it is
  // dropped for this one-time convergence and recreated by the schema re-run
  // in initSchema; a crash in between simply re-runs the (idempotent) backfill
  // on the next boot.
  db.exec('DROP TRIGGER IF EXISTS trg_donation_clawbacks_immutable_update');
  db.exec(`
    UPDATE donation_clawbacks SET
      attributed_kind = 'scholarship_funding',
      attributed_id = (SELECT sf.id FROM scholarship_fundings sf WHERE sf.donation_id = donation_clawbacks.donation_id)
    WHERE attributed_id IS NULL
      AND (SELECT COUNT(*) FROM scholarship_fundings sf WHERE sf.donation_id = donation_clawbacks.donation_id) = 1
      AND (SELECT COUNT(*) FROM sponsorship_receipts sr WHERE sr.donation_id = donation_clawbacks.donation_id) = 0
      AND (SELECT COUNT(*) FROM campaign_funding_entries e
            WHERE e.source_donation_id = donation_clawbacks.donation_id AND e.origin_kind = 'restricted_donation') = 0
  `);
  db.exec(`
    UPDATE donation_clawbacks SET
      attributed_kind = 'sponsorship_receipt',
      attributed_id = (SELECT sr.id FROM sponsorship_receipts sr WHERE sr.donation_id = donation_clawbacks.donation_id)
    WHERE attributed_id IS NULL
      AND (SELECT COUNT(*) FROM scholarship_fundings sf WHERE sf.donation_id = donation_clawbacks.donation_id) = 0
      AND (SELECT COUNT(*) FROM sponsorship_receipts sr WHERE sr.donation_id = donation_clawbacks.donation_id) = 1
      AND (SELECT COUNT(*) FROM campaign_funding_entries e
            WHERE e.source_donation_id = donation_clawbacks.donation_id AND e.origin_kind = 'restricted_donation') = 0
  `);
  db.exec(`
    UPDATE donation_clawbacks SET
      attributed_kind = 'campaign_funding_entry',
      attributed_id = (SELECT e.id FROM campaign_funding_entries e
                        WHERE e.source_donation_id = donation_clawbacks.donation_id AND e.origin_kind = 'restricted_donation')
    WHERE attributed_id IS NULL
      AND (SELECT COUNT(*) FROM scholarship_fundings sf WHERE sf.donation_id = donation_clawbacks.donation_id) = 0
      AND (SELECT COUNT(*) FROM sponsorship_receipts sr WHERE sr.donation_id = donation_clawbacks.donation_id) = 0
      AND (SELECT COUNT(*) FROM campaign_funding_entries e
            WHERE e.source_donation_id = donation_clawbacks.donation_id AND e.origin_kind = 'restricted_donation') = 1
  `);
  db.exec(`
    CREATE TRIGGER IF NOT EXISTS trg_donation_clawbacks_immutable_update
    BEFORE UPDATE ON donation_clawbacks
    WHEN NEW.donation_id IS NOT OLD.donation_id OR NEW.amount IS NOT OLD.amount
         OR NEW.status = 'open' OR OLD.status = 'repaid'
    BEGIN SELECT RAISE(ABORT, 'A clawback''s declaration is immutable; it may only transition open → repaid'); END
  `);
}

/**
 * W18: widen `fixed_assets.custody_status` with the custody-loss state.
 * SQLite cannot ALTER a CHECK constraint, so an existing (pre-W18) table is
 * rebuilt with the standard copy-swap while `foreign_keys` is OFF. Dependent
 * triggers (including the edited custody-transfer guard) are dropped first and
 * recreated by the idempotent schema re-run. Greenfield databases carry the
 * new CHECK already and skip this.
 */
function ensureFixedAssetsCustodyLossShape(schema: string): void {
  const current = db.prepare(
    `SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'fixed_assets'`,
  ).get() as { sql: string } | undefined;
  if (!current?.sql || current.sql.includes("'lost'")) return;

  const canonical = schema.match(/[\s\S]*CREATE TABLE IF NOT EXISTS fixed_assets \([\s\S]*?\n\);/);
  const ddl = canonical ? canonical[0].slice(canonical[0].indexOf('CREATE TABLE IF NOT EXISTS fixed_assets (')) : null;
  if (!ddl) throw new Error('Cannot converge fixed_assets: canonical DDL not found in schema.sql.');

  log.warn('Rebuilding fixed_assets with the W18 custody-loss state (copy-swap, foreign keys suspended).');
  const swap = db.transaction(() => {
    db.exec(ddl.replace('CREATE TABLE IF NOT EXISTS fixed_assets (', 'CREATE TABLE fixed_assets_w18_swap ('));
    db.exec(`INSERT INTO fixed_assets_w18_swap (id, name, branch_id, category_id, acquired_on, cost, source_transaction_id, custody_status, notes, created_by, created_at)
             SELECT id, name, branch_id, category_id, acquired_on, cost, source_transaction_id, custody_status, notes, created_by, created_at FROM fixed_assets`);
    const dependents = (db.prepare(
      `SELECT name FROM sqlite_master WHERE type = 'trigger' AND tbl_name != 'fixed_assets' AND sql LIKE '%fixed_assets%'`,
    ).all() as Array<{ name: string }>).map((r) => r.name);
    for (const name of dependents) db.exec(`DROP TRIGGER ${JSON.stringify(name)}`);
    db.exec('DROP TABLE fixed_assets');
    db.exec('ALTER TABLE fixed_assets_w18_swap RENAME TO fixed_assets');
  });
  swap();
  db.exec(schema);
  const violations = db.prepare('PRAGMA foreign_key_check').all();
  if (violations.length > 0) {
    throw new Error(`fixed_assets rebuild introduced foreign-key violations: ${JSON.stringify(violations).slice(0, 400)}`);
  }
}

/**
 * W19 (D-11 conformance): the owner decided AFN is the sole currency (Q1:
 * "no secondary currency, no FX rate, no multi-currency columns or conversion
 * logic anywhere"). Every writer already pins 'AFN' and no conversion logic
 * exists; the remaining gap was storage-level: the two currency label columns
 * accepted any string. Both now carry CHECK (currency = 'AFN'); existing
 * (pre-W19) databases are converged with the standard copy-swap. The check
 * enforces the owner's decision — it invents nothing.
 */
function ensureSingleCurrencyChecks(schema: string): void {
  const tables: Array<{ table: string; evidence: string; columns: string[] }> = [
    {
      table: 'level_branch_fees',
      evidence: "CHECK (currency = 'AFN')",
      columns: ['id', 'level_id', 'branch_id', 'fee', 'currency', 'effective_from', 'effective_to', 'created_at'],
    },
    {
      table: 'fee_rules',
      evidence: "CHECK (currency = 'AFN')",
      columns: ['id', 'program_version_id', 'level_id', 'branch_id', 'fee_type', 'name', 'amount', 'currency', 'is_optional', 'effective_from', 'effective_to', 'version', 'is_active', 'created_at'],
    },
  ];
  for (const { table, evidence, columns } of tables) {
    const current = db.prepare(
      `SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?`,
    ).get(table) as { sql: string } | undefined;
    if (!current?.sql || current.sql.includes(evidence)) continue;

    const start = schema.indexOf(`CREATE TABLE IF NOT EXISTS ${table} (`);
    const end = schema.indexOf('\n);', start);
    const ddl = start >= 0 && end > start ? schema.slice(start, end + 3) : null;
    if (!ddl) throw new Error(`Cannot converge ${table}: canonical DDL not found in schema.sql.`);

    log.warn(`Rebuilding ${table} with the D-11 single-currency CHECK (copy-swap, foreign keys suspended).`);
    const present = new Set((db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map((c) => c.name));
    const cols = columns.filter((name) => present.has(name)).join(', ');
    const swap = db.transaction(() => {
      db.exec(ddl.replace(`CREATE TABLE IF NOT EXISTS ${table} (`, `CREATE TABLE ${table}_w19_swap (`));
      db.exec(`INSERT INTO ${table}_w19_swap (${cols}) SELECT ${cols} FROM ${table}`);
      const dependents = (db.prepare(
        `SELECT name FROM sqlite_master WHERE type = 'trigger' AND tbl_name != ? AND sql LIKE ?`,
      ).all(table, `%${table}%`) as Array<{ name: string }>).map((r) => r.name);
      for (const name of dependents) db.exec(`DROP TRIGGER ${JSON.stringify(name)}`);
      db.exec(`DROP TABLE ${table}`);
      db.exec(`ALTER TABLE ${table}_w19_swap RENAME TO ${table}`);
    });
    swap();
    db.exec(schema);
    const violations = (db.prepare('PRAGMA foreign_key_check').all() as Array<unknown>).filter(
      (v) => JSON.stringify(v).includes(table),
    );
    if (violations.length > 0) {
      throw new Error(`${table} rebuild introduced foreign-key violations: ${JSON.stringify(violations).slice(0, 400)}`);
    }
  }
}

/**
 * W20 (D-190): widen `financial_transactions.type` with the credit/debt
 * subsystem's P&L-neutral evidence types — 'loan_proceeds', 'loan_repayment',
 * 'supplier_refund'. Same copy-swap convergence as the W16 reclaim type:
 * canonical DDL from schema.sql, dependent triggers dropped and recreated by
 * the schema re-run, foreign keys asserted clean afterwards.
 */
function ensureFinancialTransactionsCreditDebtTypes(schema: string): void {
  const current = db.prepare(
    `SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'financial_transactions'`,
  ).get() as { sql: string } | undefined;
  if (!current?.sql || current.sql.includes("'loan_proceeds'")) return;

  const canonical = schema.match(/[\s\S]*CREATE TABLE IF NOT EXISTS financial_transactions \([\s\S]*?\n\);/);
  const ddl = canonical ? canonical[0].slice(canonical[0].indexOf('CREATE TABLE IF NOT EXISTS financial_transactions (')) : null;
  if (!ddl) throw new Error('Cannot converge financial_transactions: canonical DDL not found in schema.sql.');

  log.warn('Rebuilding financial_transactions with the W20 credit/debt evidence types (copy-swap, foreign keys suspended).');
  const swap = db.transaction(() => {
    db.exec(ddl.replace('CREATE TABLE IF NOT EXISTS financial_transactions (', 'CREATE TABLE financial_transactions_w20_swap ('));
    // Copy only columns the old table actually has; everything else takes the
    // canonical default.
    const canonicalCols = ['id', 'type', 'category', 'finance_category_id', 'amount', 'date', 'description', 'reference_id', 'payment_id', 'donation_id', 'operator_name', 'operator_role', 'branch_id'];
    const present = new Set((db.prepare('PRAGMA table_info(financial_transactions)').all() as Array<{ name: string }>).map((c) => c.name));
    const cols = canonicalCols.filter((name) => present.has(name)).join(', ');
    db.exec(`INSERT INTO financial_transactions_w20_swap (${cols}) SELECT ${cols} FROM financial_transactions`);
    // DROP TABLE aborts if triggers on OTHER tables still reference this one,
    // so they are dropped first and recreated by the schema re-run below.
    const dependents = (db.prepare(
      `SELECT name FROM sqlite_master WHERE type = 'trigger' AND tbl_name != 'financial_transactions' AND sql LIKE '%financial_transactions%'`,
    ).all() as Array<{ name: string }>).map((r) => r.name);
    for (const name of dependents) db.exec(`DROP TRIGGER ${JSON.stringify(name)}`);
    db.exec('DROP TABLE financial_transactions');
    db.exec('ALTER TABLE financial_transactions_w20_swap RENAME TO financial_transactions');
  });
  swap();
  // Re-create the indexes and triggers that were dropped with the old table.
  // The full schema is idempotent and everything else already exists.
  db.exec(schema);
  const violations = db.prepare('PRAGMA foreign_key_check').all();
  if (violations.length > 0) {
    throw new Error(`financial_transactions rebuild introduced foreign-key violations: ${JSON.stringify(violations).slice(0, 400)}`);
  }
}

/**
 * W21 (D-193..D-195): converge the write-off/withholding shape onto pre-W21
 * databases — the `financial_transactions` type CHECK gains the P&L-neutral
 * 'withholding_remittance'; `student_obligations` gains 'discharged';
 * `obligation_allocations` gains source_kind 'write_off'; `invoices` gains
 * 'written_off'. Same copy-swap convergence as every prior wave: canonical
 * DDL from schema.sql, dependent triggers dropped and recreated by the
 * schema re-run, foreign keys asserted clean afterwards.
 */
function ensureWriteOffWithholdingShape(schema: string): void {
  const tables: Array<{ table: string; evidence: string; columns: string[] }> = [
    {
      table: 'financial_transactions',
      evidence: "'withholding_remittance'",
      columns: ['id', 'type', 'category', 'finance_category_id', 'amount', 'date', 'description', 'reference_id', 'payment_id', 'donation_id', 'operator_name', 'operator_role', 'branch_id'],
    },
    {
      table: 'student_obligations',
      evidence: "'discharged'",
      columns: ['id', 'student_id', 'branch_id', 'kind', 'semester_id', 'status', 'created_at'],
    },
    {
      table: 'obligation_allocations',
      evidence: "'write_off'",
      columns: ['id', 'obligation_id', 'amount', 'source_kind', 'payment_id', 'scholarship_award_id', 'scholarship_funding_id', 'sponsorship_agreement_id', 'sponsorship_receipt_id', 'status', 'reversed_at', 'reversed_by', 'reversal_reason', 'operator_name', 'date', 'created_at'],
    },
    {
      table: 'invoices',
      evidence: "'written_off'",
      columns: ['id', 'student_id', 'total_amount', 'discount_amount', 'net_amount', 'status', 'issue_date', 'due_date', 'branch_id', 'created_at', 'notes', 'invoice_number', 'issued_by', 'student_name', 'student_code', 'charge_kind', 'purpose', 'obligation_id'],
    },
  ];
  for (const { table, evidence, columns } of tables) {
    const current = db.prepare(
      `SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?`,
    ).get(table) as { sql: string } | undefined;
    if (!current?.sql || current.sql.includes(evidence)) continue;

    const start = schema.indexOf(`CREATE TABLE IF NOT EXISTS ${table} (`);
    const end = schema.indexOf('\n);', start);
    const ddl = start >= 0 && end > start ? schema.slice(start, end + 3) : null;
    if (!ddl) throw new Error(`Cannot converge ${table}: canonical DDL not found in schema.sql.`);

    log.warn(`Rebuilding ${table} with the W21 write-off/withholding shape (copy-swap, foreign keys suspended).`);
    const present = new Set((db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map((c) => c.name));
    const cols = columns.filter((name) => present.has(name)).join(', ');
    const swap = db.transaction(() => {
      db.exec(ddl.replace(`CREATE TABLE IF NOT EXISTS ${table} (`, `CREATE TABLE ${table}_w21_swap (`));
      db.exec(`INSERT INTO ${table}_w21_swap (${cols}) SELECT ${cols} FROM ${table}`);
      const dependents = (db.prepare(
        `SELECT name FROM sqlite_master WHERE type = 'trigger' AND tbl_name != ? AND sql LIKE ?`,
      ).all(table, `%${table}%`) as Array<{ name: string }>).map((r) => r.name);
      for (const name of dependents) db.exec(`DROP TRIGGER ${JSON.stringify(name)}`);
      db.exec(`DROP TABLE ${table}`);
      db.exec(`ALTER TABLE ${table}_w21_swap RENAME TO ${table}`);
    });
    swap();
    db.exec(schema);
    const violations = (db.prepare('PRAGMA foreign_key_check').all() as Array<unknown>).filter(
      (v) => JSON.stringify(v).includes(table),
    );
    if (violations.length > 0) {
      throw new Error(`${table} rebuild introduced foreign-key violations: ${JSON.stringify(violations).slice(0, 400)}`);
    }
  }
}

/**
 * W22 (D-197..D-199): converge the asset-lifecycle economics shape onto
 * pre-W22 databases — `financial_transactions` gains the P&L-neutral
 * 'disposal_proceeds' type and the finance-cost 'loan_interest' type;
 * `fixed_assets` gains 'disposed' custody plus the useful-life/in-service
 * fact columns. Copy-swap with canonical DDL, dependent triggers dropped
 * and recreated by the schema re-run, foreign keys asserted clean.
 */
function ensureAssetLifecycleShape(schema: string): void {
  const swaps: Array<{ table: string; evidence: string; columns: string[] }> = [
    {
      table: 'financial_transactions',
      evidence: "'disposal_proceeds'",
      columns: ['id', 'type', 'category', 'finance_category_id', 'amount', 'date', 'description', 'reference_id', 'payment_id', 'donation_id', 'operator_name', 'operator_role', 'branch_id'],
    },
    {
      table: 'fixed_assets',
      evidence: "'disposed'",
      columns: ['id', 'name', 'branch_id', 'category_id', 'acquired_on', 'cost', 'source_transaction_id', 'custody_status', 'notes', 'created_by', 'created_at'],
    },
  ];
  const pending: string[] = [];
  const staleW22Triggers = db.prepare(
    `SELECT name FROM sqlite_master WHERE type = 'trigger' AND (tbl_name IN ('asset_depreciations', 'asset_disposals', 'loan_interest_payments') OR name = 'trg_fixed_assets_disposal_guard')`,
  ).all() as Array<{ name: string }>;
  for (const { table, evidence, columns } of swaps) {
    const current = db.prepare(
      `SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?`,
    ).get(table) as { sql: string } | undefined;
    if (!current?.sql || current.sql.includes(evidence)) continue;

    const start = schema.indexOf(`CREATE TABLE IF NOT EXISTS ${table} (`);
    const end = schema.indexOf('\n);', start);
    const ddl = start >= 0 && end > start ? schema.slice(start, end + 3) : null;
    if (!ddl) throw new Error(`Cannot converge ${table}: canonical DDL not found in schema.sql.`);

    log.warn(`Rebuilding ${table} with the W22 asset-lifecycle shape (copy-swap, foreign keys suspended).`);
    // The main schema exec above has already CREATED the W22 triggers against
    // the not-yet-widened tables (SQLite does not resolve NEW./column refs at
    // CREATE TRIGGER time). They would explode the first ALTER … RENAME, which
    // re-validates the whole trigger corpus, so drop them here; the schema
    // re-exec after all swaps recreates them against the final shape.
    for (const trig of staleW22Triggers) db.exec(`DROP TRIGGER IF EXISTS ${JSON.stringify(trig.name)}`);
    const present = new Set((db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map((c) => c.name));
    const cols = columns.filter((name) => present.has(name)).join(', ');
    const swap = db.transaction(() => {
      db.exec(ddl.replace(`CREATE TABLE IF NOT EXISTS ${table} (`, `CREATE TABLE ${table}_w22_swap (`));
      db.exec(`INSERT INTO ${table}_w22_swap (${cols}) SELECT ${cols} FROM ${table}`);
      const dependents = (db.prepare(
        `SELECT name FROM sqlite_master WHERE type = 'trigger' AND tbl_name != ? AND sql LIKE ?`,
      ).all(table, `%${table}%`) as Array<{ name: string }>).map((r) => r.name);
      for (const name of dependents) db.exec(`DROP TRIGGER ${JSON.stringify(name)}`);
      db.exec(`DROP TABLE ${table}`);
      db.exec(`ALTER TABLE ${table}_w22_swap RENAME TO ${table}`);
    });
    swap();
    pending.push(table);
  }
  // The canonical schema's W22 triggers reference the widened columns across
  // BOTH tables (e.g. trg_asset_depreciations_bound reads
  // fixed_assets.useful_life_months). Re-executing the schema is therefore
  // deferred until every swap has landed, never between them.
  if (pending.length > 0) {
    db.exec(schema);
    for (const table of pending) {
      const violations = (db.prepare('PRAGMA foreign_key_check').all() as Array<unknown>).filter(
        (v) => JSON.stringify(v).includes(table),
      );
      if (violations.length > 0) {
        throw new Error(`${table} rebuild introduced foreign-key violations: ${JSON.stringify(violations).slice(0, 400)}`);
      }
    }
  }
}

/**
 * W22: additive contractual-fact columns on pre-existing tables — supplier
 * payment terms/due date and loan rate/maturity/schedule. ALTER TABLE ADD
 * COLUMN keeps every historical row; new columns start NULL, which reports
 * as "no terms stated" rather than an invented default.
 */
function ensureContractualFactColumns(): void {
  const adds: Array<{ table: string; column: string; ddl: string }> = [
    { table: 'supplier_invoices', column: 'terms', ddl: `ALTER TABLE supplier_invoices ADD COLUMN terms TEXT` },
    { table: 'supplier_invoices', column: 'due_on', ddl: `ALTER TABLE supplier_invoices ADD COLUMN due_on TEXT` },
    { table: 'loans', column: 'interest_rate_bps', ddl: `ALTER TABLE loans ADD COLUMN interest_rate_bps INTEGER` },
    { table: 'loans', column: 'maturity_on', ddl: `ALTER TABLE loans ADD COLUMN maturity_on TEXT` },
    { table: 'loans', column: 'schedule_note', ddl: `ALTER TABLE loans ADD COLUMN schedule_note TEXT` },
    { table: 'fixed_assets', column: 'useful_life_months', ddl: `ALTER TABLE fixed_assets ADD COLUMN useful_life_months INTEGER` },
    { table: 'fixed_assets', column: 'in_service_on', ddl: `ALTER TABLE fixed_assets ADD COLUMN in_service_on TEXT` },
  ];
  for (const { table, column, ddl } of adds) {
    const present = (db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).some((c) => c.name === column);
    if (present) continue;
    db.exec(ddl);
  }
}

function ensureFinancialTransactionsReclaimType(schema: string): void {
  const current = db.prepare(
    `SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'financial_transactions'`,
  ).get() as { sql: string } | undefined;
  if (!current?.sql || current.sql.includes("'restricted_reclaim'")) return;

  const canonical = schema.match(/CREATE TABLE IF NOT EXISTS financial_transactions \([\s\S]*?\n\);/);
  if (!canonical) throw new Error('Cannot converge financial_transactions: canonical DDL not found in schema.sql.');

  log.warn('Rebuilding financial_transactions with the W16 restricted_reclaim type (copy-swap, foreign keys suspended).');
  const swap = db.transaction(() => {
    db.exec(canonical[0].replace('CREATE TABLE IF NOT EXISTS financial_transactions (', 'CREATE TABLE financial_transactions_w16_swap ('));
    // Copy only columns the old table actually has (very old databases may
    // predate `donation_id`); everything else takes the canonical default.
    const canonicalCols = ['id', 'type', 'category', 'finance_category_id', 'amount', 'date', 'description', 'reference_id', 'payment_id', 'donation_id', 'operator_name', 'operator_role', 'branch_id'];
    const present = new Set((db.prepare('PRAGMA table_info(financial_transactions)').all() as Array<{ name: string }>).map((c) => c.name));
    const cols = canonicalCols.filter((name) => present.has(name)).join(', ');
    db.exec(`INSERT INTO financial_transactions_w16_swap (${cols}) SELECT ${cols} FROM financial_transactions`);
    // DROP TABLE aborts if triggers on OTHER tables still reference this one,
    // so they are dropped first and recreated by the schema re-run below.
    const dependents = (db.prepare(
      `SELECT name FROM sqlite_master WHERE type = 'trigger' AND tbl_name != 'financial_transactions' AND sql LIKE '%financial_transactions%'`,
    ).all() as Array<{ name: string }>).map((r) => r.name);
    for (const name of dependents) db.exec(`DROP TRIGGER ${JSON.stringify(name)}`);
    db.exec('DROP TABLE financial_transactions');
    db.exec('ALTER TABLE financial_transactions_w16_swap RENAME TO financial_transactions');
  });
  swap();
  // Re-create the indexes and triggers that were dropped with the old table.
  // The full schema is idempotent and everything else already exists.
  db.exec(schema);
  const violations = db.prepare('PRAGMA foreign_key_check').all();
  if (violations.length > 0) {
    throw new Error(`financial_transactions rebuild introduced foreign-key violations: ${JSON.stringify(violations).slice(0, 400)}`);
  }
}

function reconcileCanonicalFeeAuthority(): void {
  const rows = db.prepare(`
    SELECT branch_id, placement_test_fee, registration_fee, card_fee, diploma_fee
      FROM branch_academic_profiles
  `).all() as Array<{
    branch_id: string;
    placement_test_fee: unknown;
    registration_fee: unknown;
    card_fee: unknown;
    diploma_fee: unknown;
  }>;
  const hasRule = db.prepare('SELECT 1 FROM fee_rules WHERE branch_id = ? AND fee_type = ? LIMIT 1');
  const insertRule = db.prepare(`
    INSERT INTO fee_rules
      (id, branch_id, fee_type, name, amount, currency, is_optional, effective_from, effective_to, version, is_active, created_at)
    VALUES (?, ?, ?, ?, ?, 'AFN', 0, NULL, NULL, 1, 1, datetime('now'))
  `);
  const sanitize = (value: string) => value.replace(/[^A-Za-z0-9_-]/g, '_');
  const nameByType = {
    placement: 'Placement test fee',
    registration: 'Registration fee',
    card: 'ID card fee',
    diploma: 'Diploma fee',
  } as const;
  const tx = db.transaction(() => {
    for (const row of rows) {
      for (const [feeType, rawAmount] of [
        ['placement', row.placement_test_fee],
        ['registration', row.registration_fee],
        ['card', row.card_fee],
        ['diploma', row.diploma_fee],
      ] as const) {
        if (hasRule.get(row.branch_id, feeType)) continue;
        try {
          const amount = assertMoney(rawAmount ?? 0, `Retired ${feeType} fee storage`);
          insertRule.run(
            `legacy_fee_${sanitize(row.branch_id)}_${feeType}`,
            row.branch_id,
            feeType,
            nameByType[feeType],
            amount,
          );
        } catch {
          // Skip any non-canonical stored amount so live charge resolution must
          // stop instead of inventing a fee.
        }
      }
    }
  });
  tx();
}

/**
 * Converge a pre-W12 database onto the employee due-composition shape of
 * `employee_salary_ledger`: the `due_amount` column records the composed due
 * (base + earned bonus) a payment settled against, and the fact triggers
 * enforce paid ≤ due (advance exempt) and full ⇒ paid = due. Rows recorded
 * before due-composition keep the column DEFAULT 0 — the due that bounded
 * them was the then-current base salary, which is not recoverable and is
 * therefore NOT fabricated.
 */
function ensureEmployeeLedgerDueColumn(): void {
  const columns = db.prepare(`PRAGMA table_info(employee_salary_ledger)`).all() as Array<{ name: string }>;
  if (!columns.some((column) => column.name === 'due_amount')) {
    db.exec(`ALTER TABLE employee_salary_ledger ADD COLUMN due_amount INTEGER NOT NULL DEFAULT 0`);
  }
}

/**
 * Applies the canonical schema, then the organization hierarchy defaults.
 * Safe on every process start (fresh or existing database).
 */
export function initSchema(): void {
  const schemaPath = path.join(__dirname, 'schema.sql');
  if (!fs.existsSync(schemaPath)) {
    throw new Error(`schema.sql not found at ${schemaPath}`);
  }

  const schema = fs.readFileSync(schemaPath, 'utf-8');

  // PRAGMA foreign_keys must be set OUTSIDE a transaction in SQLite, and the
  // canonical schema declares tables in domain order rather than dependency
  // order, so constraint checking is suspended while the shape is created.
  db.pragma('foreign_keys = OFF');

  try {
    reconcileCanonicalPlacementState();
    db.exec(schema);
    ensureInvoiceChargeKindColumn();
    ensurePaymentsPayerColumns();
    ensureBookReceiptAcquisitionColumns();
    ensureEmployeeLedgerDueColumn();
    ensureRegistrationsFinancialColumnsDropped();
    ensureFinancialTransactionsCreditDebtTypes(schema);
    ensureWriteOffWithholdingShape(schema);
    ensureAssetLifecycleShape(schema);
    ensureContractualFactColumns();
    ensureSingleCurrencyChecks(schema);
    ensureDonationClawbackAttributionColumns();
    ensureFixedAssetsCustodyLossShape(schema);
    ensureFinancialTransactionsReclaimType(schema);
    reconcileCanonicalFeeAuthority();
  } catch (error) {
    log.error('Failed to apply the canonical schema.');
    throw error;
  } finally {
    db.pragma('foreign_keys = ON');
  }

  verifyCanonicalState();

  setFinanceAccountsDatabase(db);
  ensureOrganizationHierarchy(db);
}

// Initialization runs at import time so that tables exist BEFORE any other
// module prepares a statement during import hoisting.
initSchema();
