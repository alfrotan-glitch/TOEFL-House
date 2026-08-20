/**
 * Governance: rule changes and cross-branch owner activity are traceable
 * ============================================================================
 * Two business-policy items, resolved with evidence rather than assumption.
 *
 * B-3 — who may change the discount ceiling, and is the change traceable?
 *   `rule_default_discount_cap` sets the institutional discount limit and is
 *   editable at runtime. Modification was already owner/manager-gated, but the
 *   audit entry recorded the rule NAME only:
 *
 *     action="Updated rule: Discount Cap 30%"  old_value=null  new_value=null
 *
 *   That records THAT something changed, not what it changed from or to, so an
 *   unauthorised or mistaken edit to a money-governing rule is untraceable.
 *
 * B-2 — three equal owners require absolute access. Confirmed as intended, but
 *   absolute access must not cost auditability. A financial audit entry was
 *   attributed to the ACTOR's home branch, so an owner working in branch B had
 *   the entry filed under branch A — a branch-scoped audit review of B would
 *   not show it. The money row was always attributed correctly; only the audit
 *   row was wrong.
 */
import { assignRole } from './support/identity.js';
import { describe, it, expect, beforeAll } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import supertest from 'supertest';
import { db, initSchema } from '../db/connection.js';
import { signToken, hashPassword, type TokenPayload } from '../utils/auth.js';
import { bootstrapRbacCatalog } from '../core/rbac/rbac-service.js';
import { studentsRouter } from '../routes/students.routes.js';
import { errorHandler } from '../middleware/errorHandler.js';

const HOME = 'gov_home_branch';
const OTHER = 'gov_other_branch';
let app: express.Express;
let seq = 0;

/** An owner whose home branch is HOME — they will act inside OTHER. */
function owner(): TokenPayload {
  return { userId: 'u_gov_owner', username: 'gov_owner', branchId: HOME, fullName: 'Gov Owner' };
}
const auth = () => ({ Authorization: `Bearer ${signToken(owner())}` });

async function studentIn(branchId: string): Promise<string> {
  seq += 1;
  const res = await supertest(app).post('/api/students/manual').set(auth()).send({
    fullName: `Gov Student ${seq}`,
    phone: `0766${String(400000 + seq).slice(-6)}`,
    gender: 'male',
    branchId,
  });
  expect(res.status).toBe(201);
  return res.body.id;
}

beforeAll(async () => {
  initSchema();
  bootstrapRbacCatalog(db);
  for (const [id, name] of [[HOME, 'Gov Home'], [OTHER, 'Gov Other']]) {
    db.prepare('INSERT OR IGNORE INTO branches (id, name, location) VALUES (?, ?, ?)').run(id, name, 'Loc');
  }
  db.prepare(
    `INSERT OR IGNORE INTO users ( id, username, full_name, branch_id, password_hash, is_active, must_change_password )
     VALUES (?, ?, ?, ?, ?, 1, 0)`
  ).run('u_gov_owner', 'gov_owner', 'Gov Owner', HOME, await hashPassword('x'));
  assignRole('u_gov_owner', 'owner', HOME);

  app = express();
  app.use(express.json());
  app.use('/api/students', studentsRouter);
  app.use(errorHandler);
});

describe('B-2 — owner absolute access preserves attribution', () => {
  it('files a cross-branch financial audit entry under the branch the money moved in', async () => {
    const studentId = await studentIn(OTHER);
    const res = await supertest(app).post(`/api/students/${studentId}/payments`).set(auth())
      .send({ amount: 2500, category: 'other', paymentMethod: 'cash', notes: 'Owner cross-branch charge' });
    expect(res.status).toBe(201);

    const log = db.prepare(
      `SELECT operator_name, operator_role, branch_id FROM audit_logs
        WHERE action LIKE '%payment%' AND action LIKE '%Gov Student%' ORDER BY rowid DESC LIMIT 1`
    ).get() as { operator_name: string; operator_role: string; branch_id: string };

    // The actor is still the owner — absolute access is not hidden.
    expect(log.operator_name).toBe('Gov Owner');
    expect(log.operator_role).toBe('owner');
    // The regression: this used to be HOME, the owner's own branch.
    expect(log.branch_id).toBe(OTHER);
  });

  it('attributes the money itself to the student branch, not the actor branch', async () => {
    const studentId = await studentIn(OTHER);
    await supertest(app).post(`/api/students/${studentId}/payments`).set(auth())
      .send({ amount: 900, category: 'other', paymentMethod: 'cash', notes: 'Attribution check' });

    const pay = db.prepare('SELECT branch_id FROM payments WHERE student_id = ?').get(studentId) as { branch_id: string };
    const ledger = db.prepare(
      `SELECT branch_id FROM financial_transactions WHERE reference_id = ? AND type = 'income'`
    ).get(studentId) as { branch_id: string };
    expect(pay.branch_id).toBe(OTHER);
    expect(ledger.branch_id).toBe(OTHER);
  });

  it('records an audit entry for every owner financial mutation', async () => {
    const studentId = await studentIn(OTHER);
    const before = (db.prepare('SELECT COUNT(*) AS c FROM audit_logs').get() as { c: number }).c;
    await supertest(app).post(`/api/students/${studentId}/payments`).set(auth())
      .send({ amount: 1200, category: 'other', paymentMethod: 'cash', notes: 'Audited charge' });
    const after = (db.prepare('SELECT COUNT(*) AS c FROM audit_logs').get() as { c: number }).c;
    // Absolute access must never mean silent access.
    expect(after).toBeGreaterThan(before);
  });
});

describe('B-3 — rule changes capture before and after values', () => {
  it('the rules route records old and new snapshots, not just the rule name', () => {
    // Guards the source of truth: every mutating rule handler must pass a
    // snapshot. Behaviour is exercised end-to-end by the live governance probe;
    // this prevents a future edit from dropping the capture silently.
    const here = path.dirname(fileURLToPath(import.meta.url));
    const file = path.resolve(here, '..', 'routes', 'rules.routes.ts');
    const code = fs.readFileSync(file, 'utf8');

    expect(code).toContain('function ruleSnapshot');
    // Update, rollback, deactivate and delete must all record the prior state.
    const withOld = (code.match(/oldValue: ruleSnapshot\(/g) || []).length;
    expect(withOld).toBeGreaterThanOrEqual(4);
    // Create and update must record the resulting state.
    const withNew = (code.match(/newValue: ruleSnapshot\(/g) || []).length;
    expect(withNew).toBeGreaterThanOrEqual(2);
  });
});
