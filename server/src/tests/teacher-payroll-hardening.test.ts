import { describe, it, expect, beforeEach } from 'vitest';
import { db, initSchema } from '../db/connection.js';
import { computeTeacherDueAmount } from '../core/payroll/class-payroll.js';
import { today } from '../utils/ids.js';

describe('Teacher payroll hardening', () => {
  beforeEach(() => {
    initSchema();
    db.prepare(`INSERT OR IGNORE INTO branches (id,name,location) VALUES ('tp_branch','Teacher Payroll Branch','Test')`).run();
    db.prepare(`INSERT OR REPLACE INTO teachers (id,full_name,base_salary,salary_type,performance_score,status,branch_id,joined_date,default_skill_rate) VALUES ('tp_teacher','Payroll Teacher',30000,'per_session',100,'active','tp_branch',?,1000)`).run(today());
  });

  it('computes per-session salary for the requested period, not the current month', () => {
    db.prepare(`INSERT OR IGNORE INTO classes (id,name,level,branch_id,status,lifecycle_stage) VALUES ('tp_class','Payroll Class','A1','tp_branch','active','in_progress')`).run();
    db.prepare(`INSERT OR IGNORE INTO sessions (id,class_id,date,start_time,end_time,status,session_type,teacher_id,branch_id) VALUES ('tp_s1','tp_class','2026-01-05','09:00','10:00','completed','regular','tp_teacher','tp_branch'),('tp_s2','tp_class','2026-01-12','09:00','10:00','completed','regular','tp_teacher','tp_branch')`).run();
    const teacher = db.prepare('SELECT * FROM teachers WHERE id = ?').get('tp_teacher') as any;
    const result = computeTeacherDueAmount(db, teacher, '2026-01');
    expect(result.due).toBe(2000);
  });

  it('uses teacher-specific level/skill rate before generic rule fallback', () => {
    db.prepare(`INSERT OR IGNORE INTO classes (id,name,level,branch_id,status,lifecycle_stage) VALUES ('tp_class2','Level Class','B1','tp_branch','active','in_progress')`).run();
    db.prepare(`INSERT OR IGNORE INTO skills (id,name) VALUES ('tp_skill','Writing')`).run();
    db.prepare(`INSERT OR IGNORE INTO class_teacher_skills (id,class_id,teacher_id,skill_id,monthly_rate,branch_id,assignment_type) VALUES ('tp_cts','tp_class2','tp_teacher','tp_skill',0,'tp_branch','primary')`).run();
    db.prepare(`INSERT OR REPLACE INTO teacher_level_skill_rates (id,teacher_id,level_code,skill_id,rate_per_skill,branch_id) VALUES ('tp_rate','tp_teacher','B1','tp_skill',2500,'tp_branch')`).run();
    db.prepare(`UPDATE teachers SET salary_type = 'per_level' WHERE id='tp_teacher'`).run();
    const teacher = db.prepare('SELECT * FROM teachers WHERE id = ?').get('tp_teacher') as any;
    const result = computeTeacherDueAmount(db, teacher, '2026-01');
    expect(result.due).toBe(2500);
  });
});
