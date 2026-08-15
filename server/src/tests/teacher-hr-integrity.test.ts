import { describe, it, expect, beforeAll } from 'vitest';
import { db, initSchema } from '../db/connection.js';
import { today } from '../utils/ids.js';

beforeAll(() => initSchema());

describe('Teacher HR and payroll integrity', () => {
  it('records teacher branch history on transfer-capable schema', () => {
    const cols = db.prepare(`PRAGMA table_info(teacher_branch_history)`).all() as Array<{name:string}>;
    expect(cols.map(c => c.name)).toEqual(expect.arrayContaining(['teacher_id','from_branch_id','to_branch_id','effective_date']));
  });

  it('blocks a second full salary ledger entry for the same teacher and period', () => {
    db.prepare(`INSERT OR IGNORE INTO branches (id,name,location) VALUES ('hr_b','HR Branch','Test')`).run();
    db.prepare(`INSERT OR IGNORE INTO teachers (id,full_name,base_salary,salary_type,performance_score,status,branch_id,joined_date) VALUES ('hr_t','HR Teacher',10000,'fixed',100,'active','hr_b',?)`).run(today());
    db.prepare(`INSERT OR IGNORE INTO teacher_salary_ledger (id,teacher_id,period_key,period_label,due_amount,paid_amount,payment_type,transaction_id,branch_id) VALUES ('hr_l1','hr_t','2026-08','August',10000,10000,'full','hr_tx1','hr_b')`).run();
    expect(() => db.prepare(`INSERT INTO teacher_salary_ledger (id,teacher_id,period_key,period_label,due_amount,paid_amount,payment_type,transaction_id,branch_id) VALUES ('hr_l2','hr_t','2026-08','August',10000,10000,'full','hr_tx2','hr_b')`).run()).toThrow();
  });
});
