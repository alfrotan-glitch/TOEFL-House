import { describe, expect, it, beforeAll } from 'vitest';
import { db, initSchema } from '../db/connection.js';
import { teacherBranchAsOf, computeTeacherDueAmount } from '../core/payroll/class-payroll.js';

beforeAll(() => { initSchema(); });

describe('Teacher Grand Audit — historical payroll invariants', () => {
  it('resolves the teacher branch as of a historical payroll period', () => {
    // Note: organizations has no `code` column (schema.sql defines only id/name/created_at).
    db.prepare(`INSERT OR IGNORE INTO organizations (id,name) VALUES ('ta_org','TA Org')`).run();
    db.prepare(`INSERT OR IGNORE INTO campuses (id,organization_id,name,code,is_active) VALUES ('ta_c1','ta_org','Campus A','TA-A',1)`).run();
    db.prepare(`INSERT OR IGNORE INTO campuses (id,organization_id,name,code,is_active) VALUES ('ta_c2','ta_org','Campus B','TA-B',1)`).run();
    db.prepare(`INSERT OR IGNORE INTO branches (id,campus_id,name,code,is_active) VALUES ('ta_b1','ta_c1','Branch A','TA-1',1)`).run();
    db.prepare(`INSERT OR IGNORE INTO branches (id,campus_id,name,code,is_active) VALUES ('ta_b2','ta_c2','Branch B','TA-2',1)`).run();
    db.prepare(`INSERT OR IGNORE INTO teachers (id,full_name,base_salary,salary_type,performance_score,status,branch_id,joined_date,default_skill_rate) VALUES ('ta_t','Teacher A',1000,'fixed',100,'active','ta_b2','2025-01-01',0)`).run();
    db.prepare(`INSERT OR IGNORE INTO teacher_branch_history (id,teacher_id,from_branch_id,to_branch_id,effective_date,reason) VALUES ('ta_h1','ta_t','ta_b1','ta_b2','2026-07-01','transfer')`).run();
    // Before the first recorded transfer (2026-07-01), the teacher's branch is
    // the history origin (ta_b1) — see the sibling test 'uses the original
    // branch before the first recorded transfer'.
    expect(teacherBranchAsOf(db, 'ta_t', '2026-06-30', 'ta_b2')).toBe('ta_b1');
    expect(teacherBranchAsOf(db, 'ta_t', '2026-08-31', 'ta_b2')).toBe('ta_b2');
  });

});


describe('Teacher payroll historical integrity', () => {
  it('uses the original branch before the first recorded transfer', () => {
    db.prepare(`INSERT OR REPLACE INTO teachers (id, full_name, base_salary, salary_type, performance_score, status, branch_id, joined_date) VALUES ('ta_history', 'History Teacher', 10000, 'fixed', 100, 'active', 'ta_b2', '2026-01-01')`).run();
    db.prepare(`INSERT OR REPLACE INTO teacher_branch_history (id, teacher_id, from_branch_id, to_branch_id, effective_date, reason) VALUES ('tbh_history', 'ta_history', 'ta_b1', 'ta_b2', '2026-06-01', 'transfer')`).run();
    expect(teacherBranchAsOf(db, 'ta_history', '2026-05-31', 'ta_b2')).toBe('ta_b1');
    expect(teacherBranchAsOf(db, 'ta_history', '2026-06-30', 'ta_b2')).toBe('ta_b2');
  });
});
