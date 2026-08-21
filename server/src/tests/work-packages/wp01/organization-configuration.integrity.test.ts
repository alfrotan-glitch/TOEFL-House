import { beforeAll, describe, expect, it } from 'vitest';
import { db, initSchema } from '../../../db/connection.js';
import {
  createRule,
  deactivateRule,
  evaluateRules,
  getRuleVersions,
  seedDefaultRules,
  updateRule,
  validateRuleParts,
} from '../../../core/configuration/rule-engine.js';
import { AcademicCatalogService } from '../../../core/academic/catalog-service.js';
import { ClassGenerationEngine } from '../../../core/academic/class-generation-engine.js';
import { getNumberSetting, setSetting } from '../../../utils/settings.js';

const BRANCH_A = 'wp01_integrity_branch_a';
const BRANCH_B = 'wp01_integrity_branch_b';
const PROGRAM_A = 'wp01_integrity_program_a';
const PROGRAM_B = 'wp01_integrity_program_b';
const VERSION_A = 'wp01_integrity_version_a';
const VERSION_B = 'wp01_integrity_version_b';
const LEVEL_A = 'wp01_integrity_level_a';
const LEVEL_B = 'wp01_integrity_level_b';
const TERM_B = 'wp01_integrity_term_b';

beforeAll(() => {
  initSchema();
  for (const id of [BRANCH_A, BRANCH_B]) {
    db.prepare(
      `INSERT OR IGNORE INTO branches (id, campus_id, name, code, location, is_active)
       VALUES (?, 'campus_kbl', ?, ?, 'Kabul', 1)`,
    ).run(id, id, `CODE-${id}`);
  }
  for (const [program, version, level, branch] of [
    [PROGRAM_A, VERSION_A, LEVEL_A, BRANCH_A],
    [PROGRAM_B, VERSION_B, LEVEL_B, BRANCH_B],
  ]) {
    db.prepare('INSERT OR IGNORE INTO programs (id, name, branch_id) VALUES (?, ?, ?)').run(program, program, branch);
    db.prepare(
      `INSERT OR IGNORE INTO program_versions (id, program_id, version_label, version_number, status)
       VALUES (?, ?, 'v1', 1, 'draft')`,
    ).run(version, program);
    db.prepare(
      `INSERT OR IGNORE INTO levels (id, program_id, program_version_id, name, "order", is_active)
       VALUES (?, ?, ?, ?, 1, 1)`,
    ).run(level, program, version, level);
  }
  db.prepare(
    `INSERT OR IGNORE INTO academic_terms
       (id, branch_id, year, code, name, start_date, end_date)
     VALUES (?, ?, 2030, 'WP01-B', 'Branch B term', '2030-01-01', '2030-03-31')`,
  ).run(TERM_B, BRANCH_B);
});

describe('WP-01 canonical schema boundaries', () => {
  it.each([
    ['blank partner name', () => db.prepare("INSERT INTO partners (id, full_name, share_percent) VALUES ('wp01_bad_name', '   ', 1)").run()],
    ['negative partner share', () => db.prepare("INSERT INTO partners (id, full_name, share_percent) VALUES ('wp01_bad_neg', 'Bad', -1)").run()],
    ['partner share over 100', () => db.prepare("INSERT INTO partners (id, full_name, share_percent) VALUES ('wp01_bad_high', 'Bad', 101)").run()],
    ['malformed rule conditions', () => db.prepare("INSERT INTO rule_definitions (id, name, category, conditions, actions) VALUES ('wp01_bad_json', 'Bad', 'discount', '{', '[]')").run()],
    ['object rule actions', () => db.prepare("INSERT INTO rule_definitions (id, name, category, conditions, actions) VALUES ('wp01_bad_actions', 'Bad', 'discount', '[]', '{}')").run()],
    ['invalid rule active flag', () => db.prepare("INSERT INTO rule_definitions (id, name, category, conditions, actions, is_active) VALUES ('wp01_bad_active', 'Bad', 'discount', '[]', '[]', 2)").run()],
    ['invalid rule version', () => db.prepare("INSERT INTO rule_definitions (id, name, category, conditions, actions, version) VALUES ('wp01_bad_version', 'Bad', 'discount', '[]', '[]', 0)").run()],
  ])('rejects %s even when SQL bypasses HTTP validation', (_label, operation) => {
    expect(operation).toThrow();
  });

  it('enforces the aggregate partner-share ceiling on insert and update', () => {
    db.prepare("DELETE FROM partners WHERE id LIKE 'wp01_share_%'").run();
    db.prepare("INSERT INTO partners (id, full_name, share_percent) VALUES ('wp01_share_a', 'A', 60)").run();
    db.prepare("INSERT INTO partners (id, full_name, share_percent) VALUES ('wp01_share_b', 'B', 40)").run();
    expect(() => db.prepare("INSERT INTO partners (id, full_name, share_percent) VALUES ('wp01_share_c', 'C', 1)").run()).toThrow();
    expect(() => db.prepare("UPDATE partners SET share_percent = 41 WHERE id = 'wp01_share_b'").run()).toThrow();
  });

  it.each(['NaN', 'Infinity', '-Infinity', 'not-a-number'])('falls back for non-finite numeric setting %s', (stored) => {
    setSetting('wp01_non_finite', stored);
    expect(getNumberSetting('wp01_non_finite', 17)).toBe(17);
  });
});

describe('WP-01 generic-rule business boundary and history', () => {
  const warningAction = [{ type: 'warn' as const, targetKey: 'warning', message: 'matched' }];

  it.each([
    [{}, warningAction, /conditions must be an array/i],
    [[{ field: 'x', operator: 'between', rangeValue: [5, 1] }], warningAction, /minimum/i],
    [[{ field: 'x', operator: 'gt', value: '5' }], warningAction, /finite numeric value/i],
    [[{ field: 'x', operator: 'contains', value: 5 }], warningAction, /text value/i],
    [[{ field: 'x', operator: 'in', value: [true] }], warningAction, /string or finite number/i],
    [[{ field: 'x', operator: 'eq', value: { nested: true } }], warningAction, /scalar value/i],
    [[], [{ type: 'set_value', targetKey: 'x', value: { nested: true } }], /scalar value/i],
    [[], [{ type: 'calculate', targetKey: 'x' }], /formula/i],
    [[], [{ type: 'notify', targetKey: 'x', channel: 'carrier-pigeon' }], /channel/i],
  ] as const)('rejects malformed condition/action contracts', (conditions, actions, expected) => {
    expect(() => validateRuleParts(conditions, actions)).toThrow(expected);
  });

  it('fails closed when a persisted active rule violates the condition contract', () => {
    db.prepare(
      `INSERT INTO rule_definitions
         (id, name, category, conditions, actions, priority, scope_branch_id, last_modified_by)
       VALUES ('wp01_malformed_persisted_rule', 'Malformed persisted rule', 'workflow',
               '[{"field":"amount","operator":"gt","value":"not-a-number"}]',
               '[{"type":"warn","targetKey":"warning","message":"must not be skipped"}]',
               999, ?, 'corrupt')`,
    ).run(BRANCH_A);
    try {
      expect(() => evaluateRules({ category: 'workflow', branchId: BRANCH_A, data: { amount: 100 } }))
        .toThrow(/persisted rule.*malformed/i);
    } finally {
      db.prepare("DELETE FROM rule_definitions WHERE id = 'wp01_malformed_persisted_rule'").run();
    }
  });

  it('creates definition and version atomically when history persistence fails', () => {
    const before = (db.prepare('SELECT COUNT(*) c FROM rule_definitions').get() as { c: number }).c;
    db.exec(`CREATE TEMP TRIGGER wp01_abort_rule_history BEFORE INSERT ON rule_versions
             BEGIN SELECT RAISE(ABORT, 'history failed'); END;`);
    try {
      expect(() => createRule({
        name: 'Must roll back', description: '', category: 'discount', conditions: [], actions: warningAction,
        priority: 1, isActive: true, scopeBranchId: BRANCH_A, lastModifiedBy: 'ignored',
      }, 'wp01')).toThrow(/history failed/i);
      expect((db.prepare('SELECT COUNT(*) c FROM rule_definitions').get() as { c: number }).c).toBe(before);
    } finally {
      db.exec('DROP TRIGGER wp01_abort_rule_history');
    }
  });

  it('removes only the disconnected historical savings rule and preserves the live setting', () => {
    setSetting('daily_saving_percent', '37');
    db.prepare(
      `INSERT OR REPLACE INTO rule_definitions
         (id, name, category, conditions, actions, version, last_modified_by)
       VALUES ('rule_default_auto_savings', 'Disconnected savings', 'finance', '[]',
               '[{"type":"set_value","targetKey":"ignored","value":1}]', 1, 'legacy')`,
    ).run();

    seedDefaultRules();

    expect(db.prepare("SELECT id FROM rule_definitions WHERE id = 'rule_default_auto_savings'").get()).toBeUndefined();
    expect(getNumberSetting('daily_saving_percent', 0)).toBe(37);
  });

  it('versions updates and deactivation while logging every matched rule', () => {
    const rule = createRule({
      name: 'Versioned warning', description: '', category: 'discount', conditions: [], actions: warningAction,
      priority: 1, isActive: true, scopeBranchId: BRANCH_A, lastModifiedBy: 'ignored',
    }, 'creator');
    expect(getRuleVersions(rule.id).map(v => v.version)).toEqual([1]);

    const updated = updateRule(rule.id, { priority: 2 }, 'editor');
    expect(updated.version).toBe(2);
    const result = evaluateRules({ category: 'discount', branchId: BRANCH_A, data: {} });
    expect(result.warnings).toContain('matched');
    const log = db.prepare('SELECT matched FROM rule_evaluation_logs WHERE rule_id = ? ORDER BY evaluated_at DESC LIMIT 1').get(rule.id) as { matched: number };
    expect(log.matched).toBe(1);

    const deactivated = deactivateRule(rule.id, 'editor');
    expect(deactivated).toMatchObject({ version: 3, isActive: false });
    expect(getRuleVersions(rule.id).map(v => v.version)).toEqual([3, 2, 1]);
  });
});

describe('WP-01 catalog and class-generation relationship integrity', () => {
  it('rejects cross-program version copying before any version is written', () => {
    const service = new AcademicCatalogService(db);
    const before = (db.prepare('SELECT COUNT(*) c FROM program_versions WHERE program_id = ?').get(PROGRAM_A) as { c: number }).c;
    expect(() => service.createVersion({
      programId: PROGRAM_A, versionLabel: 'Cross-copy', copyFromVersionId: VERSION_B,
    })).toThrow(/same program/i);
    expect((db.prepare('SELECT COUNT(*) c FROM program_versions WHERE program_id = ?').get(PROGRAM_A) as { c: number }).c).toBe(before);
  });

  it('rejects a program version and levels from another branch during preview', () => {
    const engine = new ClassGenerationEngine(db);
    expect(() => engine.preview({ branchId: BRANCH_A, programVersionId: VERSION_B, levelIds: [LEVEL_B] }))
      .toThrow(/another branch/i);
    expect(() => engine.preview({ branchId: BRANCH_A, programVersionId: VERSION_A, levelIds: [LEVEL_B] }))
      .toThrow(/selected level must be active and belong/i);
    expect(() => engine.preview({ branchId: BRANCH_A, programVersionId: VERSION_A, levelIds: [LEVEL_A], academicTermId: TERM_B }))
      .toThrow(/term belongs to another branch/i);
  });

  it.each([-1, 1.5, 100001])('rejects invalid direct-generation capacity %s during preview', (defaultCapacity) => {
    const engine = new ClassGenerationEngine(db);
    expect(() => engine.preview({
      branchId: BRANCH_A, programVersionId: VERSION_A, levelIds: [LEVEL_A], defaultCapacity,
    })).toThrow(/capacity/i);
  });

  it('rolls back a generation run if any draft item cannot persist', () => {
    const engine = new ClassGenerationEngine(db);
    const before = (db.prepare('SELECT COUNT(*) c FROM class_generation_runs').get() as { c: number }).c;
    db.exec(`CREATE TEMP TRIGGER wp01_abort_generation_item BEFORE INSERT ON class_generation_items
             BEGIN SELECT RAISE(ABORT, 'item failed'); END;`);
    try {
      expect(() => engine.createDraft({ branchId: BRANCH_A, programVersionId: VERSION_A, levelIds: [LEVEL_A] }))
        .toThrow(/item failed/i);
      expect((db.prepare('SELECT COUNT(*) c FROM class_generation_runs').get() as { c: number }).c).toBe(before);
    } finally {
      db.exec('DROP TRIGGER wp01_abort_generation_item');
    }
  });

  it.each([
    ['cross-branch term', '{}', TERM_B, /term is inconsistent/i],
    ['non-object parameters', '[]', null, /parameters are malformed/i],
  ] as const)('rejects persisted generation corruption: %s', (_label, paramsJson, termId, expected) => {
    const suffix = termId ? 'term' : 'params';
    const runId = `wp01_corrupt_run_${suffix}`;
    const itemId = `wp01_corrupt_item_${suffix}`;
    db.prepare(
      `INSERT OR REPLACE INTO class_generation_runs
         (id, branch_id, academic_term_id, program_version_id, status, params_json)
       VALUES (?, ?, ?, ?, 'draft', ?)`,
    ).run(runId, BRANCH_A, termId, VERSION_A, paramsJson);
    db.prepare(
      `INSERT OR REPLACE INTO class_generation_items
         (id, run_id, level_id, level_name, capacity, min_viable_size, fee, proposed_name, status)
       VALUES (?, ?, ?, 'Level A', 20, 5, 0, 'Should not publish', 'pending')`,
    ).run(itemId, runId, LEVEL_A);
    const before = (db.prepare('SELECT COUNT(*) c FROM classes WHERE name = ?').get('Should not publish') as { c: number }).c;
    expect(() => new ClassGenerationEngine(db).publish(runId, 'wp01')).toThrow(expected);
    expect((db.prepare('SELECT COUNT(*) c FROM classes WHERE name = ?').get('Should not publish') as { c: number }).c).toBe(before);
    expect((db.prepare('SELECT status FROM class_generation_runs WHERE id = ?').get(runId) as { status: string }).status).toBe('draft');
  });

  it.each([
    ['negative capacity', 'capacity', -1, /capacity/i],
    ['minimum above capacity', 'min_viable_size', 21, /minimum viable size/i],
    ['fractional fee', 'fee', 0.5, /fee/i],
    ['unknown gender policy', 'gender_policy', 'unknown', /gender/i],
  ] as const)('rejects persisted generation-item corruption: %s', (_label, column, value, expected) => {
    const runId = `wp01_corrupt_item_run_${column}`;
    const itemId = `wp01_corrupt_item_${column}`;
    const className = `Corrupt ${column} must not publish`;
    db.prepare(
      `INSERT OR REPLACE INTO class_generation_runs
         (id, branch_id, program_version_id, status, params_json)
       VALUES (?, ?, ?, 'draft', '{}')`,
    ).run(runId, BRANCH_A, VERSION_A);
    db.prepare(
      `INSERT OR REPLACE INTO class_generation_items
         (id, run_id, level_id, level_name, capacity, min_viable_size, fee, proposed_name, status)
       VALUES (?, ?, ?, 'Level A', 20, 5, 0, ?, 'pending')`,
    ).run(itemId, runId, LEVEL_A, className);
    db.prepare(`UPDATE class_generation_items SET ${column} = ? WHERE id = ?`).run(value, itemId);

    expect(() => new ClassGenerationEngine(db).publish(runId, 'wp01')).toThrow(expected);
    expect(db.prepare('SELECT id FROM classes WHERE name = ?').get(className)).toBeUndefined();
    expect((db.prepare('SELECT status FROM class_generation_runs WHERE id = ?').get(runId) as { status: string }).status).toBe('draft');
  });

  it('revalidates current room capacity before publishing a stored draft', () => {
    const roomId = 'wp01_capacity_room';
    const runId = 'wp01_capacity_generation_run';
    const className = 'Room capacity must win';
    db.prepare(
      `INSERT OR REPLACE INTO rooms (id, branch_id, code, name, capacity, is_active)
       VALUES (?, ?, 'WP01-CAP', 'Capacity room', 5, 1)`,
    ).run(roomId, BRANCH_A);
    db.prepare(
      `INSERT OR REPLACE INTO class_generation_runs
         (id, branch_id, program_version_id, status, params_json)
       VALUES (?, ?, ?, 'draft', '{}')`,
    ).run(runId, BRANCH_A, VERSION_A);
    db.prepare(
      `INSERT OR REPLACE INTO class_generation_items
         (id, run_id, level_id, level_name, room_id, capacity, min_viable_size, fee, proposed_name, status)
       VALUES ('wp01_capacity_generation_item', ?, ?, 'Level A', ?, 10, 5, 0, ?, 'pending')`,
    ).run(runId, LEVEL_A, roomId, className);

    expect(() => new ClassGenerationEngine(db).publish(runId, 'wp01')).toThrow(/room capacity/i);
    expect(db.prepare('SELECT id FROM classes WHERE name = ?').get(className)).toBeUndefined();
  });

  it('does not publish a cancelled generation run', () => {
    const runId = 'wp01_cancelled_generation_run';
    db.prepare(
      `INSERT OR REPLACE INTO class_generation_runs
         (id, branch_id, program_version_id, status, params_json)
       VALUES (?, ?, ?, 'cancelled', '{}')`,
    ).run(runId, BRANCH_A, VERSION_A);
    db.prepare(
      `INSERT OR REPLACE INTO class_generation_items
         (id, run_id, level_id, level_name, capacity, min_viable_size, fee, proposed_name, status)
       VALUES ('wp01_cancelled_generation_item', ?, ?, 'Level A', 20, 5, 0,
               'Cancelled run class', 'pending')`,
    ).run(runId, LEVEL_A);
    expect(() => new ClassGenerationEngine(db).publish(runId, 'wp01')).toThrow(/cancelled|cannot publish/i);
    expect(db.prepare("SELECT id FROM classes WHERE name = 'Cancelled run class'").get()).toBeUndefined();
  });
});
