/**
 * CFG-1 — a Rule Engine rule is not authorization for a discount.
 *
 * REPRODUCED ON THE UNFIXED ENGINE (real evaluateRules, seeded catalogue,
 * manager rule `conditions: []` / `discountPercent: 95`, student asking 10%,
 * institutional cap rule at priority 200):
 *
 *     priority     1 ->  95     priority   201 ->  30
 *     priority    10 ->  95     priority   999 ->  30
 *     priority   199 ->  95     priority 10000 ->  30
 *
 * Every result exceeds the 20% ordinary maximum. Ordering decided policy,
 * because the "cap" was itself an ordinary rule inside a `priority DESC` pass.
 *
 * These tests pin the authorization boundary that replaces that behaviour:
 * the Rule Engine may compute a candidate, but the final ceiling comes from
 * authorization records + real eligibility, so no priority can move it.
 *
 * They also pin the legitimate side of the policy — Ambassador 15, second
 * degree 50, family 50, first degree 100, sponsorship 100 — so closing the
 * hole cannot quietly delete the business exceptions.
 */
import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import { db, initSchema } from '../db/connection.js';
import { evaluateRules, seedDefaultRules } from '../core/configuration/rule-engine.js';
import {
  resolveAuthorizedDiscount,
  ORDINARY_MAX,
  CATEGORY_MAX,
  APPROVER_ROLE,
  type DiscountCategory,
} from '../core/configuration/discount-authority.js';

const BR = 'dab_b1';
const OTHER = 'dab_b2';
const TODAY = new Date().toISOString().slice(0, 10);

let seq = 0;
function mkStudent(branch = BR, householdId: string | null = null): string {
  const id = `dab_s${++seq}`;
  db.prepare(
    `INSERT OR REPLACE INTO students (id, full_name, phone, student_code, branch_id, status, registration_date, gender, household_id)
     VALUES (?, ?, ?, ?, ?, 'active', date('now'), 'male', ?)`,
  ).run(id, `Student ${id}`, `079${String(3000000 + seq)}`, `DAB-${seq}`, branch, householdId);
  return id;
}

function authorize(
  studentId: string,
  category: Exclude<DiscountCategory, 'ORDINARY'>,
  approvedPercent: number,
  over: Partial<{ status: string; effective_from: string; effective_to: string; branch_id: string }> = {},
): string {
  const id = randomUUID();
  db.prepare(
    `INSERT INTO student_discount_authorizations
       (id, student_id, category, approved_percent, approved_by, approved_at, reason, status,
        effective_from, effective_to, branch_id, source)
     VALUES (?, ?, ?, ?, 'Test Approver', datetime('now'), 'test', ?, ?, ?, ?, 'manual')`,
  ).run(
    id,
    studentId,
    category,
    approvedPercent,
    over.status ?? 'active',
    over.effective_from ?? null,
    over.effective_to ?? null,
    over.branch_id ?? BR,
  );
  return id;
}

/** The real engine answer, exactly as production computes it. */
const candidate = (percent: number, leadSource = 'walk_in') =>
  Number(
    evaluateRules({ category: 'discount', branchId: BR, data: { discountPercent: percent, leadSource }, dryRun: true })
      .finalOutputs.discountPercent ?? percent,
  );

/** The full production pipeline: rules -> authorization boundary. */
const finalDiscount = (studentId: string | null, requested: number, leadSource = 'walk_in') =>
  resolveAuthorizedDiscount(db, studentId, candidate(requested, leadSource), { today: TODAY }).percent;

function addExploitRule(priority: number, value = 95) {
  db.prepare("DELETE FROM rule_definitions WHERE name = 'CFG1_EXPLOIT'").run();
  db.prepare(
    `INSERT INTO rule_definitions (id, name, description, category, conditions, actions, priority, is_active, scope_branch_id, version, created_at)
     VALUES (?, 'CFG1_EXPLOIT', '', 'discount', '[]', ?, ?, 1, ?, 1, datetime('now'))`,
  ).run(randomUUID(), JSON.stringify([{ type: 'set_value', targetKey: 'discountPercent', value }]), priority, BR);
}

beforeAll(() => {
  initSchema();
  seedDefaultRules();
  db.prepare('INSERT OR IGNORE INTO branches (id, name, location) VALUES (?, ?, ?)').run(BR, 'DAB Branch', 'Kabul');
  db.prepare('INSERT OR IGNORE INTO branches (id, name, location) VALUES (?, ?, ?)').run(OTHER, 'DAB Other', 'Kabul');
  db.prepare("INSERT OR IGNORE INTO teachers (id, full_name, phone, branch_id, status, joined_date) VALUES ('dab_t1','DAB Teacher','0790000001',?, 'active', date('now'))").run(BR);
});

beforeEach(() => {
  db.prepare("DELETE FROM rule_definitions WHERE name = 'CFG1_EXPLOIT'").run();
  db.prepare('DELETE FROM student_discount_authorizations').run();
  db.prepare('DELETE FROM student_staff_relations').run();
});

describe('CFG-1 · ordinary discounts are bounded regardless of rules', () => {
  it.each([0, 10, 15, 20])('an ordinary %i%% is allowed unchanged', (p) => {
    expect(finalDiscount(mkStudent(), p)).toBe(p);
  });

  it.each([21, 50, 95, 100, 150, 1e9])('an ordinary %i%% is bounded to 20%%', (p) => {
    expect(finalDiscount(mkStudent(), p)).toBe(ORDINARY_MAX);
  });

  // The exact CFG-1 exploit, at every priority proven vulnerable pre-fix.
  it.each([1, 10, 199, 201, 999, 10000])(
    'a manager rule at priority %i cannot exceed the ordinary maximum',
    (priority) => {
      addExploitRule(priority);
      const s = mkStudent();
      expect(candidate(10)).toBeGreaterThan(ORDINARY_MAX); // the engine IS still exploitable
      expect(finalDiscount(s, 10)).toBe(ORDINARY_MAX); // the boundary refuses it
    },
  );

  it('multiple conflicting unconditional rules cannot bypass the ceiling', () => {
    addExploitRule(5, 95);
    db.prepare(
      `INSERT INTO rule_definitions (id, name, description, category, conditions, actions, priority, is_active, scope_branch_id, version, created_at)
       VALUES (?, 'CFG1_EXPLOIT_B', '', 'discount', '[]', ?, 3, 1, ?, 1, datetime('now'))`,
    ).run(randomUUID(), JSON.stringify([{ type: 'set_value', targetKey: 'discountPercent', value: 100 }]), BR);
    expect(finalDiscount(mkStudent(), 10)).toBe(ORDINARY_MAX);
    db.prepare("DELETE FROM rule_definitions WHERE name = 'CFG1_EXPLOIT_B'").run();
  });

  it('a rule cannot manufacture an exception category', () => {
    addExploitRule(10, 100);
    const out = resolveAuthorizedDiscount(db, mkStudent(), candidate(10), { today: TODAY });
    expect(out.category).toBe('ORDINARY');
    expect(out.authorizationId).toBeNull();
    expect(out.percent).toBe(ORDINARY_MAX);
  });
});

describe('CFG-1 · Friend Referral is bounded by the ordinary ceiling', () => {
  it.each([
    [0, 10],
    [10, 20],
    [15, 20],
    [20, 20],
    [25, 20],
    [30, 20],
  ])('base %i%% + referral resolves to %i%%', (base, expected) => {
    // The engine still adds +10 (35/40 pre-boundary); policy caps the ordinary
    // outcome at 20 because referral is not an independent authorization.
    expect(finalDiscount(mkStudent(), base, 'friend')).toBe(expected);
  });

  it('referral still functions as a benefit below the ceiling', () => {
    expect(finalDiscount(mkStudent(), 0, 'friend')).toBe(10);
  });
});

describe('CFG-1 · authorized exceptions work when eligibility and approval hold', () => {
  it('Course Ambassador receives 15%', () => {
    const s = mkStudent();
    authorize(s, 'COURSE_AMBASSADOR', 15);
    const out = resolveAuthorizedDiscount(db, s, candidate(15), { today: TODAY });
    expect(out.percent).toBe(15);
    expect(out.category).toBe('COURSE_AMBASSADOR');
  });

  it('Course Ambassador cannot become 16% through an authorization or a rule', () => {
    const s = mkStudent();
    authorize(s, 'COURSE_AMBASSADOR', 99); // over-granted row
    addExploitRule(10, 95);
    const out = resolveAuthorizedDiscount(db, s, candidate(16), { today: TODAY });
    expect(out.percent).toBe(CATEGORY_MAX.COURSE_AMBASSADOR);
  });

  it('a first-degree relative may receive 100% when the relationship exists', () => {
    const s = mkStudent();
    db.prepare(
      `INSERT INTO student_staff_relations (id, student_id, staff_type, teacher_id, degree, branch_id)
       VALUES (?, ?, 'teacher', 'dab_t1', 1, ?)`,
    ).run(randomUUID(), s, BR);
    authorize(s, 'FIRST_DEGREE_RELATIVE', 100);
    const out = resolveAuthorizedDiscount(db, s, candidate(100), { today: TODAY });
    expect(out.percent).toBe(100);
    expect(out.category).toBe('FIRST_DEGREE_RELATIVE');
  });

  it('a first-degree authorization without the relationship grants nothing beyond ordinary', () => {
    const s = mkStudent();
    authorize(s, 'FIRST_DEGREE_RELATIVE', 100); // approved but NOT eligible
    expect(finalDiscount(s, 100)).toBe(ORDINARY_MAX);
  });

  it('a second-degree relative is capped at 50%', () => {
    const s = mkStudent();
    db.prepare(
      `INSERT INTO student_staff_relations (id, student_id, staff_type, teacher_id, degree, branch_id)
       VALUES (?, ?, 'teacher', 'dab_t1', 2, ?)`,
    ).run(randomUUID(), s, BR);
    authorize(s, 'SECOND_DEGREE_RELATIVE', 100); // over-granted
    const out = resolveAuthorizedDiscount(db, s, candidate(100), { today: TODAY });
    expect(out.percent).toBe(CATEGORY_MAX.SECOND_DEGREE_RELATIVE);
  });

  it('a family of 4+ receives up to 50%, a family of 3 does not qualify', () => {
    const hh = randomUUID();
    db.prepare("INSERT INTO households (id, name, branch_id) VALUES (?, 'Fam', ?)").run(hh, BR);
    const members = [mkStudent(BR, hh), mkStudent(BR, hh), mkStudent(BR, hh)];
    const target = members[0];
    authorize(target, 'FAMILY_OF_FOUR_PLUS', 50);
    // Only 3 members so far -> not eligible.
    expect(finalDiscount(target, 50)).toBe(ORDINARY_MAX);

    mkStudent(BR, hh); // 4th member joins
    expect(finalDiscount(target, 50)).toBe(50);
  });

  it('sponsorship may reach 100% when authorized', () => {
    const s = mkStudent();
    authorize(s, 'SPONSORSHIP', 100);
    const out = resolveAuthorizedDiscount(db, s, candidate(100), { today: TODAY });
    expect(out.percent).toBe(100);
    expect(out.category).toBe('SPONSORSHIP');
  });
});

describe('CFG-1 · invalid authorizations grant nothing', () => {
  it.each([
    ['revoked', { status: 'revoked' }],
    ['expired', { effective_to: '2020-01-01' }],
    ['not yet effective', { effective_from: '2099-01-01' }],
    ['another branch', { branch_id: OTHER }],
  ])('a %s authorization falls back to ordinary policy', (_label, over) => {
    const s = mkStudent();
    authorize(s, 'SPONSORSHIP', 100, over as Record<string, string>);
    expect(finalDiscount(s, 100)).toBe(ORDINARY_MAX);
  });

  it('a deleted authorization grants nothing', () => {
    const s = mkStudent();
    const id = authorize(s, 'SPONSORSHIP', 100);
    expect(finalDiscount(s, 100)).toBe(100);
    db.prepare('DELETE FROM student_discount_authorizations WHERE id = ?').run(id);
    expect(finalDiscount(s, 100)).toBe(ORDINARY_MAX);
  });
});

describe('CFG-1 · categories do not stack', () => {
  it('Ambassador 15 + Family 50 resolves to 50, never 65', () => {
    const hh = randomUUID();
    db.prepare("INSERT INTO households (id, name, branch_id) VALUES (?, 'Fam2', ?)").run(hh, BR);
    const s = mkStudent(BR, hh);
    mkStudent(BR, hh);
    mkStudent(BR, hh);
    mkStudent(BR, hh);
    authorize(s, 'COURSE_AMBASSADOR', 15);
    authorize(s, 'FAMILY_OF_FOUR_PLUS', 50);
    const out = resolveAuthorizedDiscount(db, s, candidate(50), { today: TODAY });
    expect(out.percent).toBe(50);
    expect(out.category).toBe('FAMILY_OF_FOUR_PLUS');
  });
});

describe('CFG-1 · policy constants match the authoritative business policy', () => {
  it('category maxima are exactly as specified', () => {
    expect(ORDINARY_MAX).toBe(20);
    expect(CATEGORY_MAX.COURSE_AMBASSADOR).toBe(15);
    expect(CATEGORY_MAX.SECOND_DEGREE_RELATIVE).toBe(50);
    expect(CATEGORY_MAX.FAMILY_OF_FOUR_PLUS).toBe(50);
    expect(CATEGORY_MAX.FIRST_DEGREE_RELATIVE).toBe(100);
    expect(CATEGORY_MAX.SPONSORSHIP).toBe(100);
  });

  it('the two 100% categories require owner approval', () => {
    expect(APPROVER_ROLE.FIRST_DEGREE_RELATIVE).toBe('owner');
    expect(APPROVER_ROLE.SPONSORSHIP).toBe('owner');
    expect(APPROVER_ROLE.COURSE_AMBASSADOR).toBe('manager');
    expect(APPROVER_ROLE.SECOND_DEGREE_RELATIVE).toBe('manager');
    expect(APPROVER_ROLE.FAMILY_OF_FOUR_PLUS).toBe('manager');
  });
});
